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
    /// Patient reference ("Patient/<id>") of the session this entry was
    /// queued under, when the app knew it at queue time. The outbox
    /// survives sign-out, so a drain under a DIFFERENT sign-in must hold
    /// (skip, keep, count) profile-mismatched entries instead of replaying
    /// them into another record. nil (legacy entries, or queued before the
    /// patient was resolved) drains unconditionally — single-user app, and
    /// holding forever would be worse than the pre-binding behavior.
    public var profileRef: String?

    public init(
        id: String = UUID().uuidString.lowercased(),
        queuedAt: Date = Date(),
        kind: Kind,
        profileRef: String? = nil
    ) {
        self.id = id
        self.queuedAt = queuedAt
        self.kind = kind
        self.profileRef = profileRef
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
    private let directory: URL
    private let fileURL: URL
    /// Loaded lazily on first actor-isolated access: the store is
    /// constructed during AppModel's main-thread init, and reading/decoding
    /// the queue file there would block launch — the first `await`ed member
    /// call already runs on the actor's own (non-main) executor.
    private var cache: [OutboxEntry]?
    /// Name of a corrupt queue file that load had to set aside — surfaced
    /// so the app can show a one-time notice instead of silently starting
    /// a fresh queue over unreadable health writes.
    private var setAsideFile: String?

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

    /// `directory` is created (if missing) on first access; the queue file
    /// lives inside it. Init does NO file IO — see `cache`.
    public init(directory: URL) {
        self.directory = directory
        self.fileURL = directory.appendingPathComponent("outbox.json")
    }

    private func entries() -> [OutboxEntry] {
        if let cache { return cache }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var loaded: [OutboxEntry] = []
        if let data = try? Data(contentsOf: fileURL) {
            if let decoded = try? Self.decoder.decode([OutboxEntry].self, from: data) {
                loaded = decoded
            } else {
                // Never clobber bytes we could not read — they are queued
                // HEALTH WRITES. Preserve the corrupt file for manual
                // recovery and start a fresh queue alongside it.
                let aside = fileURL.deletingLastPathComponent()
                    .appendingPathComponent("outbox.corrupt-\(UUID().uuidString.prefix(8)).json")
                if (try? FileManager.default.moveItem(at: fileURL, to: aside)) != nil {
                    setAsideFile = aside.lastPathComponent
                }
            }
        }
        cache = loaded
        return loaded
    }

    public var count: Int { entries().count }

    public func all() -> [OutboxEntry] { entries() }

    public func contains(id: String) -> Bool {
        entries().contains { $0.id == id }
    }

    /// The corrupt queue file preserved at load time, if any — for the
    /// app's one-time "some offline changes could not be read" notice.
    public func corruptFileSetAside() -> String? {
        _ = entries() // ensure the load (and set-aside detection) happened
        return setAsideFile
    }

    /// All-or-nothing: the entry is queued ONLY once its bytes are on disk.
    /// A `try?` here used to report success for an entry that existed only
    /// in memory — lost on termination while the UI said "queued". Callers
    /// must surface the failure to the user instead.
    public func append(_ entry: OutboxEntry) throws {
        var updated = entries()
        updated.append(entry)
        try write(updated) // throws → cache untouched, nothing half-queued
        cache = updated
    }

    public func remove(id: String) {
        var updated = entries()
        updated.removeAll { $0.id == id }
        cache = updated
        // Removal-persist is best-effort, unlike append: if this write
        // fails the entry merely reappears on next launch and its
        // idempotent replay converges — a redundant write, never a lost one.
        try? write(updated)
    }

    /// Remove entries matching a predicate (used to supersede stale queued
    /// actions for the same logical event once a newer action lands).
    public func removeAll(matching predicate: (OutboxEntry) -> Bool) {
        var updated = entries()
        updated.removeAll(where: predicate)
        cache = updated
        try? write(updated) // best-effort — see remove(id:)
    }

    public func removeAll() {
        cache = []
        try? write([]) // best-effort — see remove(id:)
    }

    private func write(_ updated: [OutboxEntry]) throws {
        let data = try Self.encoder.encode(updated)
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
            // Strongest protection class, kept deliberately: every append is
            // a foreground user action (dose tap, check-in, quick add), so
            // the device is unlocked at write time. The only background
            // writer in the app — HealthKit sync — goes straight through
            // RecordAPI and never touches this queue, so no code path needs
            // write-while-locked and there is no reason to weaken to
            // .completeUntilFirstUserAuthentication. If a locked-device
            // write ever does happen, it now surfaces as a thrown error
            // instead of silently claiming "queued".
            options.insert(.completeFileProtection)
        #endif
        try data.write(to: fileURL, options: options)
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
///
/// An actor so save/load — encoding a 91-day dose window and writing it —
/// run on the actor's own executor instead of blocking the main actor on
/// every refresh; callers hop back only to assign the loaded state.
public actor SnapshotStore {
    private let directory: URL
    private let fileURL: URL

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

    /// Init does NO file IO (it runs on the caller's thread — AppModel's
    /// main-thread init); the directory is created on first save.
    public init(directory: URL) {
        self.directory = directory
        self.fileURL = directory.appendingPathComponent("core-snapshot.json")
    }

    public func load() -> CoreSnapshot? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? Self.decoder.decode(CoreSnapshot.self, from: data)
    }

    public func save(_ snapshot: CoreSnapshot) {
        // Best-effort by design: this is a read CACHE of the CDR — a failed
        // write costs a cold-launch fallback, never data.
        guard let data = try? Self.encoder.encode(snapshot) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
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
    /// Entries the SERVER definitively rejected (validation 4xx on the
    /// replay itself) — dropped from the queue but surfaced loudly; silent
    /// retry-forever would hide them.
    public var failures: [(label: String, message: String)]
    public var remaining: Int
    /// True when the drain stopped because the session was definitively
    /// rejected (refresh token invalid — the client has already wiped its
    /// tokens). The app must fall back to sign-in; entries stay queued and
    /// drain after the next sign-in. Without this signal the UI keeps
    /// promising "syncs when your server is reachable" under a dead session.
    public var stoppedForAuth = false
    /// Entries held (skipped AND kept — never auto-discarded) because they
    /// were queued under a different signed-in profile (see
    /// `OutboxEntry.profileRef`). Surfaced so nothing is silently withheld.
    public var heldForOtherProfile = 0
}

/// Front door for the offline-tolerant writes. Tries the live path first;
/// on `MedplumError.network` (offline / server unreachable) the payload is
/// queued and an echo returned. Everything else — validation errors,
/// authentication — rethrows.
public actor SyncEngine {
    private let record: RecordAPI
    private let outbox: OutboxStore
    private var draining = false
    /// Logical events (dose slot / check-in period) with a write currently
    /// in flight — live or replay. The actor is reentrant at every `await`,
    /// so without this claim a drain replaying a queued entry and a live
    /// correction for the SAME event can interleave, and whichever server
    /// write lands last wins (same identifier, update-in-place) — a stale
    /// replay would silently revert the newer action. One claim per event
    /// serializes them instead.
    private var activeEventKeys: Set<String> = []
    private var eventKeyWaiters: [String: [CheckedContinuation<Void, Never>]] = [:]
    /// Patient reference ("Patient/<id>") of the CURRENT session, provided
    /// by the app whenever it knows it (fresh core load, or the on-device
    /// snapshot) — stamped onto queued entries so the queue, which survives
    /// sign-out, never replays under a different sign-in (see drain()).
    private var currentProfileRef: String?
    /// Quick-observation payloads frozen at FIRST submission, keyed by the
    /// un-stamped observation content: identifiers are stamped once per
    /// user action, not per call, so a user-level retry after a partial
    /// live failure converges on the already-committed observations instead
    /// of re-creating them under fresh UUIDs. Entries are dropped when the
    /// action lands (synced, or queued — the outbox payload carries the
    /// identifiers from there); a non-network failure keeps the entry for
    /// the retry. Bounded in practice: entries only accumulate for failed
    /// actions the user abandons, each a few hundred bytes.
    private var frozenObservationPayloads: [String: ObservationsPayload] = [:]

    private static let contentKeyEncoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys] // stable across identical retries
        return e
    }()

    public init(record: RecordAPI, outbox: OutboxStore) {
        self.record = record
        self.outbox = outbox
    }

    /// The app calls this whenever it (re)learns which patient the current
    /// session writes to; nil when signed out or not yet resolved.
    public func setCurrentProfile(_ ref: String?) {
        currentProfileRef = ref
    }

    /// The cross-path identity of the logical event a queued write targets.
    /// Quick observations have no correction semantics (independent
    /// idempotent creates), so they carry no claim.
    private static func eventKey(for kind: OutboxEntry.Kind) -> String? {
        switch kind {
        case .dose(let payload): return "dose|\(payload.identValue)"
        case .checkin(let payload): return "checkin|\(payload.periodIdent)"
        case .observations: return nil
        }
    }

    /// Claim exclusive write access to one logical event, suspending while
    /// another write (a drain replay or a live action) holds it.
    private func claim(_ key: String) async {
        while activeEventKeys.contains(key) {
            await withCheckedContinuation { continuation in
                eventKeyWaiters[key, default: []].append(continuation)
            }
        }
        activeEventKeys.insert(key)
    }

    private func releaseClaim(_ key: String) {
        activeEventKeys.remove(key)
        if let waiters = eventKeyWaiters.removeValue(forKey: key) {
            for waiter in waiters {
                waiter.resume()
            }
        }
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
        // If drain is mid-replay of a queued action for this same slot, wait
        // for it to finish: raced, the replay's older write could land after
        // ours and revert the correction on the server.
        let key = "dose|\(payload.identValue)"
        await claim(key)
        defer { releaseClaim(key) }
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
            // A failed queue-persist must never masquerade as "queued" —
            // append throws, and the caller shows a real failure instead.
            try await outbox.append(OutboxEntry(kind: .dose(payload), profileRef: currentProfileRef))
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
        // Same rule as logDose: never race a live submit against an
        // in-flight replay of a queued response for this period.
        let key = "checkin|\(payload.periodIdent)"
        await claim(key)
        defer { releaseClaim(key) }
        do {
            let result = try await record.applyCheckin(payload)
            await purgeSamePeriod() // stale queued responses for this period
            return .synced(result)
        } catch MedplumError.network {
            await purgeSamePeriod() // collapse to the latest answers
            // Throws on a failed queue-persist — never claim "queued" for an
            // entry that only exists in memory (see OutboxStore.append).
            try await outbox.append(OutboxEntry(kind: .checkin(payload), profileRef: currentProfileRef))
            return .queued(RecordAPI.echoResponse(payload))
        }
    }

    /// Identifiers are stamped once PER USER ACTION, not per call (client
    /// event UUID convention, FHIR-MAPPING §7 quick-observation): the
    /// stamped payload is frozen on first submission and reused when the
    /// same action is retried after a partial live failure — a fresh stamp
    /// on retry would re-create the observations that committed before the
    /// failure. See `frozenObservationPayloads`.
    public func saveQuickObservations(_ observations: [FHIRObservation]) async throws -> WriteResult<Int> {
        let retryKey = Self.retryKey(for: observations)
        let payload: ObservationsPayload
        if let retryKey, let frozen = frozenObservationPayloads[retryKey] {
            payload = frozen
        } else {
            payload = ObservationsPayload(observations: RecordAPI.stampQuickIdentifiers(observations))
            if let retryKey { frozenObservationPayloads[retryKey] = payload }
        }
        do {
            try await record.applyObservations(payload)
            if let retryKey { frozenObservationPayloads[retryKey] = nil }
            return .synced(payload.observations.count)
        } catch MedplumError.network {
            // Throws on a failed queue-persist (the frozen payload is then
            // kept, so the user's retry still reuses the same identifiers).
            try await outbox.append(OutboxEntry(kind: .observations(payload), profileRef: currentProfileRef))
            if let retryKey { frozenObservationPayloads[retryKey] = nil }
            return .queued(payload.observations.count)
        }
        // Any other error rethrows above with the frozen payload retained —
        // that is what makes the user-level retry idempotent.
    }

    /// Stable content key for one user action's un-stamped observations
    /// (sorted-keys JSON): identical retries produce identical keys.
    private static func retryKey(for observations: [FHIRObservation]) -> String? {
        guard let data = try? contentKeyEncoder.encode(observations) else { return nil }
        return String(bytes: data, encoding: .utf8)
    }

    // MARK: Drain

    /// Replay queued writes in FIFO order.
    ///
    /// Error policy — these are HEALTH WRITES, so dropping one is worse than
    /// retrying it:
    /// - the ONLY drop is an `MedplumError.http` 4xx (except 429) raised by
    ///   the replay itself: the server saw this payload and definitively
    ///   rejected it — retrying forever would poison the queue, so drop it
    ///   and report it loudly.
    /// - everything else is not a verdict on the entry: offline, signed-out,
    ///   5xx / 429, a malformed reply (captive portal returning 200+HTML),
    ///   the patient lookup coming up empty, the token refresh misbehaving —
    ///   stop the drain and keep the entry (and everything after it) queued
    ///   for next time.
    public func drain() async -> DrainReport {
        guard !draining else { return DrainReport(applied: 0, failures: [], remaining: await outbox.count) }
        draining = true
        defer { draining = false }

        var applied = 0
        var failures: [(String, String)] = []
        var stoppedForAuth = false
        var held = 0

        // Bind the drain to the CURRENT session's patient when any entry is
        // profile-stamped: the outbox survives sign-out, and an entry queued
        // under a different sign-in must be HELD (skipped, kept, counted) —
        // never replayed into another record, never auto-discarded.
        var currentPatientRef: String?
        if await outbox.all().contains(where: { $0.profileRef != nil }) {
            do {
                guard let patient = try await record.getPatient(), let id = patient.id else {
                    // Whose record this session writes to cannot be
                    // established right now (seed not run / transient empty
                    // search) — hold everything rather than guess.
                    return DrainReport(applied: 0, failures: [], remaining: await outbox.count)
                }
                currentPatientRef = "Patient/\(id)"
            } catch MedplumError.unauthenticated {
                return DrainReport(
                    applied: 0, failures: [], remaining: await outbox.count, stoppedForAuth: true
                )
            } catch {
                return DrainReport(applied: 0, failures: [], remaining: await outbox.count)
            }
        }

        loop: for entry in await outbox.all() {
            if let entryProfile = entry.profileRef, let current = currentPatientRef, entryProfile != current {
                held += 1
                continue
            }
            // Claim the entry's logical event first: a live write for the
            // same slot/period that is already in flight fully lands (and
            // purges this entry) before the replay looks at it — and no live
            // write can start while the replay holds the claim.
            let key = Self.eventKey(for: entry.kind)
            if let key { await claim(key) }
            defer { if let key { releaseClaim(key) } }
            // The snapshot driving this loop goes stale at every suspension
            // point (the actor is reentrant): a live write may have
            // superseded and purged this entry mid-drain. Replaying it
            // anyway would overwrite the newer action on the server (same
            // identifier, update-in-place) — re-check it is still queued.
            guard await outbox.contains(id: entry.id) else { continue }
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
            } catch MedplumError.http(let status, let message) where (400 ... 499).contains(status) && status != 429 {
                // Definitive validation rejection of THIS payload. (Auth
                // trouble never lands here: 401s surface as .unauthenticated
                // and token-endpoint failures as .authRefreshFailed.)
                await outbox.remove(id: entry.id)
                failures.append((entry.label, "\(message) (HTTP \(status))"))
            } catch MedplumError.unauthenticated {
                // The session was definitively rejected mid-drain (the
                // client has already wiped its tokens). Stop and KEEP the
                // entries — they drain after the next sign-in — but tell
                // the caller, so the app flips to sign-in instead of
                // promising a sync that can never happen.
                stoppedForAuth = true
                break loop
            } catch {
                break loop // transient or unclassified — keep the entry
            }
        }
        return DrainReport(
            applied: applied,
            failures: failures,
            remaining: await outbox.count,
            stoppedForAuth: stoppedForAuth,
            heldForOtherProfile: held
        )
    }
}
