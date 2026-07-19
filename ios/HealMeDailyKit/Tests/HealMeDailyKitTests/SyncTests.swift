import XCTest
@testable import HealMeDailyKit

/// Outbox mechanics + payload/echo invariants. Network apply paths are
/// covered indirectly: live and replay share the same applyX functions, and
/// the idempotency guarantees rest on the identifiers asserted here.
final class SyncTests: XCTestCase {

    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("outbox-tests-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private func sampleSlot(action: DoseAction = .taken) -> DoseSlot {
        var request = MedicationRequest(id: "req1", status: "active")
        request.identifier = [Identifier(system: FHIR.medicationRequestIdentSystem, value: "lisinopril-10mg")]
        request.medicationReference = Reference(reference: "Medication/m1")
        let med = MedInfo(
            request: request,
            name: "Lisinopril",
            instructions: "1 tablet",
            lifeCritical: false,
            times: ["09:00:00"],
            cartridge: nil,
            startDate: "2026-07-01"
        )
        return DoseEngine.slotsForDate([med], date: "2026-07-13").first!
    }

    // MARK: Outbox persistence

    func testOutboxPersistsAcrossReload() async {
        let store = OutboxStore(directory: directory)
        let payload = RecordAPI.doseLogPayload(slot: sampleSlot(), action: .taken)
        await store.append(OutboxEntry(kind: .dose(payload)))
        await store.append(OutboxEntry(kind: .checkin(CheckinPayload(
            periodIdent: "daily-check-in-2026-07-13",
            questionnaireUrl: "https://healmedaily.local/fhir/Questionnaire/daily-check-in",
            items: [],
            authored: "2026-07-13T09:00:00.000Z"
        ))))

        let reloaded = OutboxStore(directory: directory)
        let entries = await reloaded.all()
        XCTAssertEqual(entries.count, 2)
        // FIFO order survives the round trip — replay order is a correctness
        // property ("taken then corrected" must land in recorded order).
        if case .dose(let first) = entries[0].kind {
            XCTAssertEqual(first.identValue, "lisinopril-10mg-2026-07-13T09:00")
        } else {
            XCTFail("first entry should be the dose")
        }
        if case .checkin(let second) = entries[1].kind {
            XCTAssertEqual(second.periodIdent, "daily-check-in-2026-07-13")
        } else {
            XCTFail("second entry should be the check-in")
        }
    }

    func testOutboxRemoveById() async {
        let store = OutboxStore(directory: directory)
        let entry = OutboxEntry(kind: .observations(ObservationsPayload(observations: [])))
        await store.append(entry)
        let count = await store.count
        XCTAssertEqual(count, 1)
        await store.remove(id: entry.id)
        let after = await store.count
        XCTAssertEqual(after, 0)
    }

    func testOutboxRemoveMatchingSupersedesSameSlot() async {
        let store = OutboxStore(directory: directory)
        let slot = sampleSlot()
        await store.append(OutboxEntry(kind: .dose(RecordAPI.doseLogPayload(slot: slot, action: .taken))))
        await store.append(OutboxEntry(kind: .checkin(CheckinPayload(
            periodIdent: "daily-check-in-2026-07-13", questionnaireUrl: nil, items: [], authored: "x"
        ))))
        // Supersede the dose for this slot; the check-in must survive.
        await store.removeAll(matching: { entry in
            if case .dose(let p) = entry.kind { return p.identValue == slot.identValue }
            return false
        })
        let remaining = await store.all()
        XCTAssertEqual(remaining.count, 1)
        if case .checkin = remaining[0].kind {} else { XCTFail("check-in should remain") }
    }

    func testOutboxPreservesUnreadableFileInsteadOfClobbering() async {
        // A corrupt queue file must be set aside, not silently overwritten —
        // it may hold undelivered health writes.
        let fileURL = directory.appendingPathComponent("outbox.json")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? Data("{ not valid json".utf8).write(to: fileURL)
        let store = OutboxStore(directory: directory)
        let count = await store.count
        XCTAssertEqual(count, 0, "starts with a fresh queue")
        let sidecars = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        XCTAssertTrue(sidecars.contains { $0.hasPrefix("outbox.corrupt-") }, "corrupt file preserved for recovery")
    }

    // MARK: Payload / echo invariants

    func testDosePayloadCarriesSlotIdentityAndScheduledTimeForSkips() {
        let slot = sampleSlot()
        let payload = RecordAPI.doseLogPayload(slot: slot, action: .skipped)
        XCTAssertEqual(payload.identValue, slot.identValue)
        XCTAssertEqual(payload.requestId, "req1")
        // Skips pin clinical time to the scheduled slot, not "now".
        XCTAssertEqual(payload.effectiveDateTime, RecordAPI.isoInstant(slot.scheduled))
        XCTAssertNil(payload.deviceRef)
        XCTAssertNil(payload.decrementDeviceId)
    }

    func testDosePayloadBackdatedTakenTime() {
        let takenAt = Date(timeIntervalSince1970: 1_784_000_000)
        let payload = RecordAPI.doseLogPayload(slot: sampleSlot(), action: .taken, takenAt: takenAt)
        XCTAssertEqual(payload.effectiveDateTime, RecordAPI.isoInstant(takenAt))
    }

    func testEchoAdministrationMatchesSlotByIdentifier() {
        let slot = sampleSlot()
        let payload = RecordAPI.doseLogPayload(slot: slot, action: .skipped)
        let echo = RecordAPI.echoAdministration(payload)
        // The echo must be indistinguishable from a server admin for slot
        // matching: DoseEngine.adminForSlot goes strictly by identifier.
        XCTAssertNotNil(DoseEngine.adminForSlot([echo], slot))
        XCTAssertEqual(echo.status, "not-done")
        XCTAssertEqual(echo.statusReason?.first?.coding?.first?.code, "user-skipped")
    }

    func testStampQuickIdentifiersIsStablePerCall() {
        let obs = [FHIRObservation(status: "final"), FHIRObservation(status: "final")]
        let stamped = RecordAPI.stampQuickIdentifiers(obs)
        let values = stamped.compactMap { $0.identifier?.first?.value }
        XCTAssertEqual(values.count, 2)
        XCTAssertNotEqual(values[0], values[1])
        XCTAssertTrue(stamped.allSatisfy { $0.identifier?.first?.system == FHIR.quickObservationIdentSystem })
    }

    func testOutboxEntryKindRoundTripsThroughJSON() throws {
        let payload = ObservationsPayload(observations: RecordAPI.stampQuickIdentifiers([FHIRObservation(status: "final")]))
        let entry = OutboxEntry(kind: .observations(payload))
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(OutboxEntry.self, from: encoder.encode(entry))
        XCTAssertEqual(decoded.id, entry.id)
        if case .observations(let round) = decoded.kind {
            XCTAssertEqual(round.observations.first?.identifier?.first?.value,
                           payload.observations.first?.identifier?.first?.value)
        } else {
            XCTFail("kind should round-trip")
        }
    }

    func testMedInfoSnapshotRoundTripsThroughJSON() throws {
        let slot = sampleSlot()
        let decoded = try JSONDecoder().decode(MedInfo.self, from: JSONEncoder().encode(slot.med))
        XCTAssertEqual(decoded.name, "Lisinopril")
        XCTAssertEqual(decoded.times, ["09:00:00"])
        XCTAssertEqual(DoseEngine.slotsForDate([decoded], date: "2026-07-13").first?.identValue, slot.identValue)
    }
}
