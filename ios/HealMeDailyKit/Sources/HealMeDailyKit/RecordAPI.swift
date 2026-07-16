import Foundation

/// FHIR data layer over MedplumClient — the iOS counterpart of the
/// network-bound helpers in `frontend/src/fhir.ts`. Every write is
/// idempotent (stable business identifier + conditional create /
/// update-in-place); every search is server-side filtered and bounded.
public struct RecordAPI: Sendable {
    public let client: MedplumClient

    public init(client: MedplumClient) {
        self.client = client
    }

    // MARK: Patient

    /// The single owner Patient, found by its stable seed identifier.
    /// nil until `make seed` has run — callers treat that as "not set up yet".
    public func getPatient() async throws -> Patient? {
        try await client.searchOne(Patient.self, [
            ("identifier", "\(FHIR.patientIdentSystem)|\(FHIR.patientIdentValue)"),
        ])
    }

    // MARK: Medications

    /// All cartridge Devices, any status (disabled ones still render, grayed).
    public func loadCartridges() async throws -> [CartridgeInfo] {
        let devices = try await client.searchResources(Device.self, [
            ("type", "\(FHIR.csDevice)|medication-cartridge"),
            ("_count", "50"),
        ])
        return devices.map { CartridgeInfo(device: $0) }
    }

    /// Every ACTIVE MedicationRequest joined with its Medication and assigned
    /// cartridge — one `_include` round trip plus the cartridge fleet.
    public func loadMeds() async throws -> [MedInfo] {
        let bundle = try await client.search("MedicationRequest", [
            ("status", "active"),
            ("_include", "MedicationRequest:medication"),
            ("_count", "100"),
        ])
        let requests = bundle.resources(MedicationRequest.self)
        var medications: [String: Medication] = [:]
        for medication in bundle.resources(Medication.self) {
            if let id = medication.id { medications[id] = medication }
        }
        let cartridges = try await loadCartridges()

        return requests.map { request in
            let medication = request.medicationReference?.id(ofType: "Medication").flatMap { medications[$0] }
            let dosage = request.dosageInstruction?.first
            // authoredOn anchors the clinical start; fall back to record
            // creation converted to the LOCAL calendar date.
            let startDate: String
            if let authored = request.authoredOn {
                startDate = String(authored.prefix(10))
            } else if let updated = request.meta?.lastUpdated, let parsed = Self.parseInstant(updated) {
                startDate = DoseEngine.localDateString(parsed)
            } else {
                startDate = ""
            }
            return MedInfo(
                request: request,
                name: medication?.code?.text ?? "Unnamed medication",
                instructions: dosage?.text ?? "",
                lifeCritical: request.extensions?.contains {
                    $0.url == FHIR.extLifeCritical && $0.valueBoolean == true
                } ?? false,
                times: dosage?.timing?.repeatValue?.timeOfDay ?? [],
                cartridge: cartridges.first {
                    $0.enabled && $0.medicationRef == request.medicationReference?.reference
                },
                startDate: startDate
            )
        }
    }

    // MARK: Dose log

    /// Dose events in the trailing `days` window, matched to slots by
    /// identifier. Paginates past the 1000-per-page max so adherence windows
    /// are always COMPLETE — a silently truncated page would skew stats.
    public func loadAdmins(days: Int) async throws -> [MedicationAdministration] {
        let start = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
        return try await client.searchAll(MedicationAdministration.self, [
            ("effective-time", "ge\(DoseEngine.localDateString(start))"),
            ("_count", "1000"),
        ])
    }

    /// Log (or change) one logical dose event — the exact `logDose` port.
    /// Idempotent per slot: the identifier makes retries, double-taps and
    /// corrections converge on a single MedicationAdministration.
    @discardableResult
    public func logDose(
        patientId: String,
        slot: DoseSlot,
        action: DoseAction,
        takenAt: Date? = nil
    ) async throws -> MedicationAdministration {
        let identToken = "\(FHIR.administrationIdentSystem)|\(slot.identValue)"
        // One identifier search decides create-vs-correct for this slot.
        let existing = try await client.searchOne(MedicationAdministration.self, [
            ("identifier", identToken),
        ])

        var base = MedicationAdministration(
            identifier: [Identifier(system: FHIR.administrationIdentSystem, value: slot.identValue)],
            status: action == .taken ? "completed" : "not-done",
            subject: Reference(reference: "Patient/\(patientId)"),
            medicationReference: slot.med.request.medicationReference,
            request: Reference(reference: "MedicationRequest/\(slot.med.request.id ?? "")"),
            // Taken doses carry the (backdatable) taken time; skips/misses
            // pin effectiveDateTime to the scheduled slot time instead.
            effectiveDateTime: action == .taken
                ? Self.isoInstant(takenAt ?? Date())
                : Self.isoInstant(slot.scheduled)
        )
        switch action {
        case .taken:
            if let cartridge = slot.med.cartridge {
                base.device = [Reference(reference: "Device/\(cartridge.device.id ?? "")")]
            }
        case .skipped:
            base.statusReason = [CodeableConcept(coding: [
                Coding(system: FHIR.csAdherence, code: "user-skipped", display: "Skipped by user"),
            ])]
        case .missed:
            base.statusReason = [CodeableConcept(coding: [
                Coding(system: FHIR.csAdherence, code: "user-marked-missed", display: "Marked missed by user"),
            ])]
        }

        // Capture prior state first — the inventory delta depends on the
        // TRANSITION (taken↔not-taken), not on the final status alone.
        let wasTaken = existing?.status == "completed"
        let result: MedicationAdministration
        if let existing {
            base.id = existing.id
            base.meta = existing.meta
            result = try await client.update(base)
        } else {
            result = try await client.createIfNoneExist(base, query: "identifier=\(identToken)")
        }

        // Display-only inventory (never gates taking a med): decrement on a
        // new "taken", restore when a taken dose is corrected.
        let delta = (action == .taken && !wasTaken) ? -1.0 : (action != .taken && wasTaken) ? 1.0 : 0.0
        if delta != 0, let cartridge = slot.med.cartridge, cartridge.remaining != nil,
           let deviceId = cartridge.device.id {
            var device = try await client.read(Device.self, id: deviceId)
            let capacity = device.property?
                .first { $0.type?.coding?.contains { $0.code == "capacity" } ?? false }?
                .valueQuantity?.first?.value ?? .greatestFiniteMagnitude
            if let propIndex = device.property?.firstIndex(where: { prop in
                prop.type?.coding?.contains { $0.code == "remaining-count" } ?? false
            }), let current = device.property?[propIndex].valueQuantity?.first?.value {
                let next = min(max(current + delta, 0), capacity)
                if next != current {
                    device.property?[propIndex].valueQuantity?[0].value = next
                    _ = try await client.update(device)
                }
            }
        }
        return result
    }

    // MARK: Check-ins

    /// Every active questionnaire carrying a cadence tag, with its
    /// current-period response — two round trips total (one Questionnaire
    /// search, one comma-OR identifier search), sorted D → W → M.
    public func loadCheckins(today: Date = Date()) async throws -> [CheckinDef] {
        let questionnaires = try await client.searchResources(Questionnaire.self, [
            ("status", "active"),
            ("_count", "50"),
        ])
        var tagged: [CheckinDef] = []
        for questionnaire in questionnaires {
            guard
                let code = questionnaire.extensions?.first(where: { $0.url == FHIR.extCadence })?.valueCode,
                let cadence = Cadence(rawValue: code),
                let url = questionnaire.url,
                let key = url.split(separator: "/").last
            else { continue }
            tagged.append(CheckinDef(
                questionnaire: questionnaire,
                cadence: cadence,
                periodIdent: CheckinEngine.periodIdentValue(questionnaireKey: String(key), cadence: cadence, today: today)
            ))
        }

        if !tagged.isEmpty {
            let tokens = tagged
                .map { "\(FHIR.questionnaireResponseIdentSystem)|\($0.periodIdent)" }
                .joined(separator: ",")
            let responses = try await client.searchResources(QuestionnaireResponse.self, [
                ("identifier", tokens),
                ("_count", "50"),
            ])
            var byIdent: [String: QuestionnaireResponse] = [:]
            for response in responses {
                if response.identifier?.system == FHIR.questionnaireResponseIdentSystem,
                   let value = response.identifier?.value {
                    byIdent[value] = response
                }
            }
            for i in tagged.indices {
                tagged[i].existing = byIdent[tagged[i].periodIdent]
            }
        }

        let order: [Cadence] = [.daily, .weekly, .monthly]
        return tagged.sorted {
            (order.firstIndex(of: $0.cadence) ?? 0) < (order.firstIndex(of: $1.cadence) ?? 0)
        }
    }

    /// Persist one check-in: stamps canonical questionnaire url, Patient
    /// subject, authored=now and the stable period identifier, then updates
    /// in place when a response for this period already exists (idempotent
    /// by construction — a resubmit never duplicates).
    @discardableResult
    public func submitCheckin(_ def: CheckinDef, items: [QuestionnaireResponseItem]) async throws -> QuestionnaireResponse {
        guard let patient = try await getPatient(), let patientId = patient.id else {
            throw MedplumError.invalidResponse("No patient record — run make seed on the server")
        }
        var response = QuestionnaireResponse(
            identifier: Identifier(system: FHIR.questionnaireResponseIdentSystem, value: def.periodIdent),
            questionnaire: def.questionnaire.url,
            status: "completed",
            subject: Reference(reference: "Patient/\(patientId)"),
            authored: Self.isoInstant(Date()),
            item: items
        )
        if let existing = def.existing {
            response.id = existing.id
            return try await client.update(response)
        }
        return try await client.create(response)
    }

    // MARK: Follow-up tasks

    /// Open symptom follow-up Tasks (display-only workflow — resolution is
    /// always the user's action, never automatic).
    public func loadFollowUps() async throws -> [FHIRTask] {
        try await client.searchResources(FHIRTask.self, [
            ("status", "requested"),
            ("code", "\(FHIR.csTask)|symptom-follow-up"),
            ("_sort", "-_lastUpdated"),
            ("_count", "50"),
        ])
    }

    public func completeFollowUp(_ task: FHIRTask) async throws {
        var updated = task
        updated.status = "completed"
        _ = try await client.update(updated)
    }

    // MARK: Quick observations

    /// Shared save path for manual quick-add entries: resolves the Patient,
    /// stamps each FHIRObservation with a fresh quick-observation identifier
    /// (client event UUID — the manual-entry idempotency convention) and
    /// creates them. Manual entry never goes through the review queue; that
    /// gate is for AI/OCR extractions only.
    public func saveQuickObservations(_ build: (String) -> [FHIRObservation]) async throws {
        guard let patient = try await getPatient(), let patientId = patient.id else {
            throw MedplumError.invalidResponse("No patient record — run make seed on the server")
        }
        for var observation in build("Patient/\(patientId)") {
            // Subject is stamped centrally (mirrors the web useSaveObservation):
            // builders return code/value/effective, this path owns identity.
            observation.subject = Reference(reference: "Patient/\(patientId)")
            observation.identifier = [
                Identifier(system: FHIR.quickObservationIdentSystem, value: UUID().uuidString.lowercased()),
            ]
            _ = try await client.create(observation)
        }
    }

    /// Bounded FHIRObservation search for dashboards (server-side filtered).
    public func loadObservations(_ params: [(String, String)]) async throws -> [FHIRObservation] {
        try await client.searchResources(FHIRObservation.self, params)
    }

    /// Pending ingestion-review-queue size, counted straight from the CDR —
    /// stays honest even while the ai-service is down.
    public func reviewQueueCount() async throws -> Int {
        let bundle = try await client.search("Task", [
            ("status", "requested"),
            ("code", "\(FHIR.csIngest)|review-ingestion-proposal"),
            ("_total", "accurate"),
            ("_count", "0"),
        ])
        return bundle.total ?? 0
    }

    // MARK: Formatting

    /// UTC ISO instant with milliseconds — the same wire format as the web
    /// app's `new Date().toISOString()`.
    public static func isoInstant(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    /// Parse a FHIR instant (with or without fractional seconds).
    public static func parseInstant(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }
}
