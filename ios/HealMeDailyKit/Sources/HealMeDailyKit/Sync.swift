import Foundation

/// Offline write-outbox for the three capture paths (dose log, check-in,
/// quick observations). Design rules:
///
/// - The CDR stays the record (CLAUDE.md rule): the outbox holds only
///   not-yet-delivered writes, never a clinical side-database. Each payload
///   is self-contained and carries the SAME stable business identifier the
///   online path would use, so a replay — or a replay raced against a
///   successful-but-unacknowledged first attempt — converges on one resource
///   (conditional create / update-in-place, FHIR-MAPPING §1/§7).
/// - Only `MedplumError.network` queues. HTTP errors (validation, auth)
///   rethrow to the caller: a rejected write must be seen, not retried
///   forever.
/// - Entries replay in FIFO order, so "taken, then corrected to skipped"
///   recorded offline lands in the recorded order and converges on the
///   final state.
/// - Backdating survives the queue: `effectiveDateTime` is resolved when the
///   user acts (clinical time), not when the entry finally syncs
///   (`meta.lastUpdated` keeps the record-write time, CLAUDE.md §6).

// MARK: - Payloads (Codable, self-contained — no live UI objects)

/// Everything needed to (re)apply one dose-log action without the original
/// `DoseSlot` in memory.
public struct DoseLogPayload: Codable, Sendable, Hashable {
    /// The cross-client dose-slot identity `{request-slug}-{date}T{HH:MM}`.
    public var identValue: String
    public var requestId: String
    public var medicationReference: Reference?
    /// Stamped on the administration when the dose was taken from a cartridge.
    public var deviceRef: String?
    /// Cartridge Device to decrement (set only when it tracks remaining-count).
    public var decrementDeviceId: String?
    /// DoseAction rawValue (taken | skipped | missed).
    public var action: String
    /// Clinical time, resolved at capture (backdatable).
    public var effectiveDateTime: String

    public init(
        identValue: String,
        requestId: String,
        medicationReference: Reference?,
        deviceRef: String?,
        decrementDeviceId: String?,
        action: String,
        effectiveDateTime: String
    ) {
        self.identValue = identValue
        self.requestId = requestId
        self.medicationReference = medicationReference
        self.deviceRef = deviceRef
        self.decrementDeviceId = decrementDeviceId
        self.action = action
        self.effectiveDateTime = effectiveDateTime
    }
}

public struct CheckinPayload: Codable, Sendable, Hashable {
    /// Stable period identifier (`{key}-{period}`) — the dedup key.
    public var periodIdent: String
    public var questionnaireUrl: String?
    public var items: [QuestionnaireResponseItem]
    /// Clinical authored time, resolved at capture.
    public var authored: String

    public init(periodIdent: String, questionnaireUrl: String?, items: [QuestionnaireResponseItem], authored: String) {
        self.periodIdent = periodIdent
        self.questionnaireUrl = questionnaireUrl
        self.items = items
        self.authored = authored
    }
}

public struct ObservationsPayload: Codable, Sendable, Hashable {
    /// Observations with their quick-observation identifiers ALREADY stamped
    /// (stamped once, at capture — that is what makes replays idempotent).
    /// Subject is stamped at apply time from the resolved Patient.
    public var observations: [FHIRObservation]

    public init(observations: [FHIRObservation]) {
        self.observations = observations
    }
}

public struct OutboxEntry: Codable, Sendable, Identifiable {
    public enum Kind: Codable, Sendable {
        case dose(DoseLogPayload)
        case checkin(CheckinPayload)
        case observations(ObservationsPayload)
    }

    public var id: String
    public var queuedAt: Date
    public var kind: Kind

    public init(id: String = UUID().uuidString.lowercased(), queuedAt: Date = Date(), kind: Kind) {
        self.id = id
        self.queuedAt = queuedAt
        self.kind = kind
    }

    /// Short human label for sync-failure surfacing.
    public var label: String {
        switch kind {
        case .dose(let p): return "Dose log (\(p.action)) \(p.identValue)"
        case .checkin(let p): return "Check-in \(p.periodIdent)"
        case .observations(let p): return "\(p.observations.count) logged value(s)"
        }
    }
}

// MARK: - OutboxStore (file-backed FIFO queue)

/// Persisted queue of pending writes. One JSON file, written atomically with
/// iOS Data Protection (complete) — pending health writes are encrypted at
/// rest like everything else on this device.
public actor OutboxStore {
    private let fileURL: URL
    private var entries: [OutboxEntry]

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    /// `directory` is created if missing; the queue file lives inside it.
    public init(directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        self.fileURL = directory.appendingPathComponent("outbox.json")
        if let data = try? Data(contentsOf: fileURL) {
            if let loaded = try? Self.decoder.decode([OutboxEntry].self, from: data) {
                self.entries = loaded
            } else {
                // Never clobber bytes we could not read — they are queued
                // HEALTH WRITES. Preserve the corrupt file for manual
                // recovery and start a fresh queue alongside it.
                self.entries = []
                let aside = fileURL.deletingLastPathComponent()
                    .appendingPathComponent("outbox.corrupt-\(UUID().uuidString.prefix(8)).json")
                try? FileManager.default.moveItem(at: fileURL, to: aside)
            }
        } else {
            self.entries = []
        }
    }

    public var count: Int { entries.count }

    public func all() -> [OutboxEntry] { entries }

    public func append(_ entry: OutboxEntry) {
        entries.append(entry)
        persist()
    }

    public func remove(id: String) {
        entries.removeAll { $0.id == id }
        persist()
    }

    /// Remove entries matching a predicate (used to supersede stale queued
    /// actions for the same logical event once a newer action lands).
    public func removeAll(matching predicate: (OutboxEntry) -> Bool) {
        entries.removeAll(where: predicate)
        persist()
    }

    public func removeAll() {
        entries = []
        persist()
    }

    private func persist() {
        guard let data = try? Self.encoder.encode(entries) else { return }
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
            options.insert(.completeFileProtection)
        #endif
        try? data.write(to: fileURL, options: options)
    }
}

// MARK: - Core snapshot (offline launch cache)

/// Read cache of the shared slot-model data (patient + meds + dose window)
/// so a cold launch without connectivity still shows the record. This is a
/// CACHE of the CDR, never a second source of truth: it is overwritten on
/// every successful refresh and cleared on sign-out.
public struct CoreSnapshot: Codable, Sendable {
    public var patient: Patient?
    public var meds: [MedInfo]
    public var admins: [MedicationAdministration]
    public var savedAt: Date

    public init(patient: Patient?, meds: [MedInfo], admins: [MedicationAdministration], savedAt: Date = Date()) {
        self.patient = patient
        self.meds = meds
        self.admins = admins
        self.savedAt = savedAt
    }
}

/// One protected JSON file for the core snapshot (same at-rest posture as
/// the outbox: atomic writes + iOS Data Protection complete).
public struct SnapshotStore: Sendable {
    private let fileURL: URL

    public init(directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        self.fileURL = directory.appendingPathComponent("core-snapshot.json")
    }

    public func load() -> CoreSnapshot? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(CoreSnapshot.self, from: data)
    }

    public func save(_ snapshot: CoreSnapshot) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(snapshot) else { return }
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
            options.insert(.completeFileProtection)
        #endif
        try? data.write(to: fileURL, options: options)
    }

    public func clear() {
        try? FileManager.default.removeItem(at: fileURL)
    }
}

// MARK: - SyncEngine

/// A write either reached the server (`synced`, carrying the server echo) or
/// was queued (`queued`, carrying a locally-synthesized echo so the UI can
/// reflect the action immediately; the next drain + refresh replaces it with
/// server truth).
public enum WriteResult<Resource: Sendable>: Sendable {
    case synced(Resource)
    case queued(Resource)

    public var resource: Resource {
        switch self {
        case .synced(let r), .queued(let r): return r
        }
    }

    public var wasQueued: Bool {
        if case .queued = self { return true }
        return false
    }
}

public struct DrainReport: Sendable {
    public var applied: Int
    /// Entries the SERVER rejected (non-network error) — dropped from the
    /// queue but surfaced loudly; silent retry-forever would hide them.
    public var failures: [(label: String, message: String)]
    public var remaining: Int
}

/// Front door for the offline-tolerant writes. Tries the live path first;
/// on `MedplumError.network` (offline / server unreachable) the payload is
/// queued and an echo returned. Everything else — validation errors,
/// authentication — rethrows.
public actor SyncEngine {
    private let record: RecordAPI
    private let outbox: OutboxStore
    private var draining = false

    public init(record: RecordAPI, outbox: OutboxStore) {
        self.record = record
        self.outbox = outbox
    }

    public var pendingCount: Int {
        get async { await outbox.count }
    }

    public func pendingEntries() async -> [OutboxEntry] {
        await outbox.all()
    }

    // MARK: Writes

    public func logDose(slot: DoseSlot, action: DoseAction, takenAt: Date? = nil) async throws -> WriteResult<MedicationAdministration> {
        let payload = RecordAPI.doseLogPayload(slot: slot, action: action, takenAt: takenAt)
        do {
            let result = try await record.applyDoseLog(payload)
            // A live write is the newest intent for this slot — any queued
            // entries for the same slot are now stale; replaying them later
            // would silently revert this correction.
            await outbox.removeAll(matching: { entry in
                if case .dose(let queued) = entry.kind { return queued.identValue == payload.identValue }
                return false
            })
            return .synced(result)
        } catch MedplumError.network {
            // Collapse to the latest action per slot: FIFO replay would reach
            // the same end state, but one entry means one write and no
            // transient flip-flop on the server.
            await outbox.removeAll(matching: { entry in
                if case .dose(let queued) = entry.kind { return queued.identValue == payload.identValue }
                return false
            })
            await outbox.append(OutboxEntry(kind: .dose(payload)))
            return .queued(RecordAPI.echoAdministration(payload))
        }
    }

    public func submitCheckin(_ def: CheckinDef, items: [QuestionnaireResponseItem]) async throws -> WriteResult<QuestionnaireResponse> {
        let payload = CheckinPayload(
            periodIdent: def.periodIdent,
            questionnaireUrl: def.questionnaire.url,
            items: items,
            authored: RecordAPI.isoInstant(Date())
        )
        func purgeSamePeriod() async {
            await outbox.removeAll(matching: { entry in
                if case .checkin(let queued) = entry.kind { return queued.periodIdent == payload.periodIdent }
                return false
            })
        }
        do {
            let result = try await record.applyCheckin(payload)
            await purgeSamePeriod() // stale queued responses for this period
            return .synced(result)
        } catch MedplumError.network {
            await purgeSamePeriod() // collapse to the latest answers
            await outbox.append(OutboxEntry(kind: .checkin(payload)))
            return .queued(RecordAPI.echoResponse(payload))
        }
    }

    public func saveQuickObservations(_ observations: [FHIRObservation]) async throws -> WriteResult<Int> {
        // Identifiers stamped HERE, once — replays reuse them (client event
        // UUID convention, FHIR-MAPPING §7 quick-observation).
        let payload = ObservationsPayload(observations: RecordAPI.stampQuickIdentifiers(observations))
        do {
            try await record.applyObservations(payload)
            return .synced(payload.observations.count)
        } catch MedplumError.network {
            await outbox.append(OutboxEntry(kind: .observations(payload)))
            return .queued(payload.observations.count)
        }
    }

    // MARK: Drain

    /// Replay queued writes in FIFO order.
    ///
    /// Error policy — these are HEALTH WRITES, so dropping one is worse than
    /// retrying it:
    /// - network / signed-out / 5xx / 429: TRANSIENT — stop the drain, keep
    ///   the entry (and everything after it) queued for next time.
    /// - anything else (validation 4xx): the server definitively rejected
    ///   this payload — retrying forever would poison the queue, so drop it
    ///   and report it loudly.
    public func drain() async -> DrainReport {
        guard !draining else { return DrainReport(applied: 0, failures: [], remaining: await outbox.count) }
        draining = true
        defer { draining = false }

        var applied = 0
        var failures: [(String, String)] = []
        loop: for entry in await outbox.all() {
            do {
                switch entry.kind {
                case .dose(let payload):
                    _ = try await record.applyDoseLog(payload)
                case .checkin(let payload):
                    _ = try await record.applyCheckin(payload)
                case .observations(let payload):
                    try await record.applyObservations(payload)
                }
                await outbox.remove(id: entry.id)
                applied += 1
            } catch MedplumError.network, MedplumError.unauthenticated {
                break loop // offline or needs sign-in — retry after that clears
            } catch MedplumError.http(let status, _) where status >= 500 || status == 429 {
                break loop // server trouble — keep queued, try again later
            } catch {
                await outbox.remove(id: entry.id)
                failures.append((entry.label, error.localizedDescription))
            }
        }
        return DrainReport(applied: applied, failures: failures, remaining: await outbox.count)
    }
}
