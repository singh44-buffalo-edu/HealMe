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
        try await applyDoseLog(Self.doseLogPayload(slot: slot, action: action, takenAt: takenAt))
    }

    /// Freeze one dose action into a self-contained, queueable payload.
    /// Clinical time is resolved NOW (backdatable takenAt; skips/misses pin
    /// to the scheduled slot time) so an offline entry syncs with the time
    /// the user acted, not the time connectivity returned.
    public static func doseLogPayload(slot: DoseSlot, action: DoseAction, takenAt: Date? = nil) -> DoseLogPayload {
        DoseLogPayload(
            identValue: slot.identValue,
            requestId: slot.med.request.id ?? "",
            medicationReference: slot.med.request.medicationReference,
            deviceRef: slot.med.cartridge.flatMap { cartridge in
                cartridge.device.id.map { "Device/\($0)" }
            },
            decrementDeviceId: (slot.med.cartridge?.remaining != nil) ? slot.med.cartridge?.device.id : nil,
            action: action.rawValue,
            effectiveDateTime: action == .taken
                ? Self.isoInstant(takenAt ?? Date())
                : Self.isoInstant(slot.scheduled)
        )
    }

    /// Locally-synthesized echo of the administration a payload will create —
    /// matched by identifier exactly like the server resource, so slot state
    /// flips immediately while the write is still queued.
    public static func echoAdministration(_ payload: DoseLogPayload) -> MedicationAdministration {
        var echo = MedicationAdministration(
            identifier: [Identifier(system: FHIR.administrationIdentSystem, value: payload.identValue)],
            status: payload.action == DoseAction.taken.rawValue ? "completed" : "not-done",
            medicationReference: payload.medicationReference,
            request: Reference(reference: "MedicationRequest/\(payload.requestId)"),
            effectiveDateTime: payload.effectiveDateTime
        )
        echo.statusReason = Self.statusReason(for: payload.action)
        return echo
    }

    private static func statusReason(for action: String) -> [CodeableConcept]? {
        switch action {
        case DoseAction.skipped.rawValue:
            return [CodeableConcept(coding: [
                Coding(system: FHIR.csAdherence, code: "user-skipped", display: "Skipped by user"),
            ])]
        case DoseAction.missed.rawValue:
            return [CodeableConcept(coding: [
                Coding(system: FHIR.csAdherence, code: "user-marked-missed", display: "Marked missed by user"),
            ])]
        default:
            return nil
        }
    }

    /// Apply one dose-log payload (live path and outbox replay share this).
    /// Behavior is the verbatim port of web `logDose`: identifier search
    /// decides create-vs-correct; inventory delta follows the taken↔not-taken
    /// TRANSITION; the decrement is display-only and never gates the med.
    @discardableResult
    public func applyDoseLog(_ payload: DoseLogPayload) async throws -> MedicationAdministration {
        guard let patient = try await getPatient(), let patientId = patient.id else {
            throw MedplumError.invalidResponse("No patient record — run make seed on the server")
        }
        let identToken = "\(FHIR.administrationIdentSystem)|\(payload.identValue)"
        // One identifier search decides create-vs-correct for this slot.
        let existing = try await client.searchOne(MedicationAdministration.self, [
            ("identifier", identToken),
        ])

        let taken = payload.action == DoseAction.taken.rawValue
        var base = MedicationAdministration(
            identifier: [Identifier(system: FHIR.administrationIdentSystem, value: payload.identValue)],
            status: taken ? "completed" : "not-done",
            subject: Reference(reference: "Patient/\(patientId)"),
            medicationReference: payload.medicationReference,
            request: Reference(reference: "MedicationRequest/\(payload.requestId)"),
            effectiveDateTime: payload.effectiveDateTime
        )
        if taken {
            if let deviceRef = payload.deviceRef {
                base.device = [Reference(reference: deviceRef)]
            }
        } else {
            base.statusReason = Self.statusReason(for: payload.action)
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
        let delta = (taken && !wasTaken) ? -1.0 : (!taken && wasTaken) ? 1.0 : 0.0
        if delta != 0, let deviceId = payload.decrementDeviceId {
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
        try await applyCheckin(CheckinPayload(
            periodIdent: def.periodIdent,
            questionnaireUrl: def.questionnaire.url,
            items: items,
            authored: Self.isoInstant(Date())
        ))
    }

    /// Locally-synthesized echo of the response a payload will create.
    public static func echoResponse(_ payload: CheckinPayload) -> QuestionnaireResponse {
        QuestionnaireResponse(
            identifier: Identifier(system: FHIR.questionnaireResponseIdentSystem, value: payload.periodIdent),
            questionnaire: payload.questionnaireUrl,
            status: "completed",
            authored: payload.authored,
            item: payload.items
        )
    }

    /// Apply one check-in payload (live path and outbox replay share this).
    /// A fresh identifier search decides update-vs-create — replay-safe even
    /// when the period's response appeared from elsewhere in the meantime.
    @discardableResult
    public func applyCheckin(_ payload: CheckinPayload) async throws -> QuestionnaireResponse {
        guard let patient = try await getPatient(), let patientId = patient.id else {
            throw MedplumError.invalidResponse("No patient record — run make seed on the server")
        }
        var response = QuestionnaireResponse(
            identifier: Identifier(system: FHIR.questionnaireResponseIdentSystem, value: payload.periodIdent),
            questionnaire: payload.questionnaireUrl,
            status: "completed",
            subject: Reference(reference: "Patient/\(patientId)"),
            authored: payload.authored,
            item: payload.items
        )
        let identToken = "\(FHIR.questionnaireResponseIdentSystem)|\(payload.periodIdent)"
        if let existing = try await client.searchOne(QuestionnaireResponse.self, [("identifier", identToken)]) {
            response.id = existing.id
            return try await client.update(response)
        }
        // Conditional create (mirrors web CheckinPage): a double-tap or retry
        // races to ONE response for the period instead of duplicating.
        return try await client.createIfNoneExist(response, query: "identifier=\(identToken)")
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
        try await applyObservations(ObservationsPayload(
            observations: Self.stampQuickIdentifiers(build("Patient/\(patientId)"))
        ))
    }

    /// Stamp each observation with a fresh quick-observation identifier
    /// (client event UUID, FHIR-MAPPING §7) — done ONCE, at capture, so a
    /// queued payload replays onto the same identifiers.
    public static func stampQuickIdentifiers(_ observations: [FHIRObservation]) -> [FHIRObservation] {
        observations.map { observation in
            var stamped = observation
            stamped.identifier = [
                Identifier(system: FHIR.quickObservationIdentSystem, value: UUID().uuidString.lowercased()),
            ]
            return stamped
        }
    }

    /// Apply one quick-observations payload (live path and outbox replay
    /// share this). Sequential conditional creates, not a transaction —
    /// mirrors the web's documented choice for independent quick-add values;
    /// If-None-Exist on the pre-stamped identifier makes a partial-failure
    /// replay converge instead of duplicating.
    public func applyObservations(_ payload: ObservationsPayload) async throws {
        guard let patient = try await getPatient(), let patientId = patient.id else {
            throw MedplumError.invalidResponse("No patient record — run make seed on the server")
        }
        for var observation in payload.observations {
            // Subject is stamped centrally (mirrors the web useSaveObservation):
            // builders return code/value/effective, this path owns identity.
            observation.subject = Reference(reference: "Patient/\(patientId)")
            guard let ident = observation.identifier?.first, let value = ident.value else {
                throw MedplumError.invalidResponse("Quick observation missing its identifier")
            }
            _ = try await client.createIfNoneExist(
                observation,
                query: "identifier=\(FHIR.quickObservationIdentSystem)|\(value)"
            )
        }
    }

    /// Bounded FHIRObservation search for dashboards (server-side filtered).
    public func loadObservations(_ params: [(String, String)]) async throws -> [FHIRObservation] {
        try await client.searchResources(FHIRObservation.self, params)
    }

    // MARK: HealthKit sync

    /// Save HealthKit-mapped observations idempotently. Per-sample kinds
    /// converge on their HK-UUID identifier via conditional create; daily
    /// aggregates additionally UPDATE in place when a re-sync brings a
    /// different final value (late-arriving watch data for yesterday).
    @discardableResult
    public func saveHealthKitObservations(_ observations: [FHIRObservation]) async throws -> (saved: Int, corrected: Int) {
        guard let patient = try await getPatient(), let patientId = patient.id else {
            throw MedplumError.invalidResponse("No patient record — run make seed on the server")
        }
        var saved = 0
        var corrected = 0
        for var observation in observations {
            observation.subject = Reference(reference: "Patient/\(patientId)")
            guard let identValue = observation.identifier?.first?.value else { continue }
            let query = "identifier=\(HealthKitMapping.identSystem)|\(identValue)"
            // Returns the fresh resource OR the pre-existing one (that's the
            // point of If-None-Exist) — same value either way means done.
            let result = try await client.createIfNoneExist(observation, query: query)
            if result.valueQuantity?.value == observation.valueQuantity?.value {
                saved += 1
                continue
            }
            // Existing aggregate with a stale value — correct it in place.
            var fix = observation
            fix.id = result.id
            fix.meta = result.meta
            _ = try await client.update(fix)
            corrected += 1
        }
        return (saved, corrected)
    }

    // MARK: Labs / trends / profile (read-only loaders)

    /// Full lab history, newest-first (mirrors web LabsPage: category=
    /// laboratory, no date bound — draws are sparse and multi-year context is
    /// the point). Newest-first means hitting the page cap drops the OLDEST
    /// draws; the caller surfaces a truncation notice, never silence.
    public func loadLabObservations(maxPages: Int = 10) async throws -> [FHIRObservation] {
        try await client.searchAll(FHIRObservation.self, [
            ("category", "laboratory"),
            ("_sort", "-date"),
            ("_count", "1000"),
        ], maxPages: maxPages)
    }

    /// The four trend signals in one comma-OR code search (mirrors web
    /// TrendsPage: weight = verified LOINC, sleep/mood/energy = local codes).
    public func loadTrendObservations(days: Int) async throws -> [FHIRObservation] {
        let start = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
        return try await client.searchResources(FHIRObservation.self, [
            ("code", [
                "\(FHIR.loinc)|29463-7",
                "\(FHIR.csObservation)|sleep-duration",
                "\(FHIR.csObservation)|mood",
                "\(FHIR.csObservation)|energy",
            ].joined(separator: ",")),
            ("date", "ge\(DoseEngine.localDateString(start))"),
            ("_count", "1000"),
            ("_sort", "-date"),
        ])
    }

    public func loadConditions() async throws -> [Condition] {
        try await client.searchResources(Condition.self, [
            ("_sort", "-_lastUpdated"),
            ("_count", "200"),
        ])
    }

    public func loadAllergies() async throws -> [AllergyIntolerance] {
        try await client.searchResources(AllergyIntolerance.self, [
            ("_sort", "-_lastUpdated"),
            ("_count", "200"),
        ])
    }

    public func loadImmunizations() async throws -> [Immunization] {
        try await client.searchResources(Immunization.self, [
            ("_sort", "-_lastUpdated"),
            ("_count", "200"),
        ])
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
