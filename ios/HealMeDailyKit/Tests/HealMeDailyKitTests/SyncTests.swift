import XCTest
@testable import HealMeDailyKit

/// Outbox mechanics + payload/echo invariants. Network apply paths are
/// covered indirectly: live and replay share the same applyX functions, and
/// the idempotency guarantees rest on the identifiers asserted here.
final class SyncTests: XCTestCase {

    private var directory: URL!

    override func setUp() {
        super.setUp()
        SyncStubURLProtocol.handler = nil
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("outbox-tests-\(UUID().uuidString)")
    }

    override func tearDown() {
        SyncStubURLProtocol.handler = nil
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

    // MARK: SyncEngine drain (wire-level, via SyncStubURLProtocol)

    /// A SyncEngine over the REAL RecordAPI/MedplumClient stack, with the
    /// wire stubbed — drain behavior is pinned end to end, not against a fake.
    private func makeEngine() -> (engine: SyncEngine, outbox: OutboxStore, client: MedplumClient) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SyncStubURLProtocol.self]
        let store = InMemoryTokenStore()
        store.save(TokenSet(
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresAt: Date().addingTimeInterval(3600),
            baseURL: "https://example.test/"
        ))
        let client = MedplumClient(
            baseURL: URL(string: "https://example.test/")!,
            tokenStore: store,
            session: URLSession(configuration: config)
        )
        let outbox = OutboxStore(directory: directory)
        return (SyncEngine(record: RecordAPI(client: client), outbox: outbox), outbox, client)
    }

    private static let patientBundle = Data(
        #"{"resourceType":"Bundle","type":"searchset","entry":[{"resource":{"resourceType":"Patient","id":"p1"}}]}"#.utf8
    )
    private static let emptyBundle = Data(#"{"resourceType":"Bundle","type":"searchset"}"#.utf8)
    private static let adminBody = Data(
        #"{"resourceType":"MedicationAdministration","id":"ma1","status":"completed"}"#.utf8
    )
    private static let observationBody = Data(#"{"resourceType":"Observation","id":"o1","status":"final"}"#.utf8)

    private func queuedObservationsEntry(_ outbox: OutboxStore) async {
        await outbox.append(OutboxEntry(kind: .observations(ObservationsPayload(
            observations: RecordAPI.stampQuickIdentifiers([FHIRObservation(status: "final")])
        ))))
    }

    /// Bug A, stale-snapshot half: an entry superseded and purged by a live
    /// write WHILE the drain is replaying an earlier entry must never reach
    /// the wire — replaying it would revert the correction (same identifier,
    /// update-in-place).
    func testDrainSkipsEntryPurgedByLiveWriteMidDrain() async throws {
        let (engine, outbox, _) = makeEngine()
        let slot = sampleSlot()
        await queuedObservationsEntry(outbox) // replayed first, gated below
        await outbox.append(OutboxEntry(kind: .dose(RecordAPI.doseLogPayload(slot: slot, action: .skipped))))

        let reachedObservationPost = expectation(description: "drain is mid-replay of the first entry")
        let gate = DispatchSemaphore(value: 0)
        var adminWrites = 0
        SyncStubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? "GET"
            if path.hasSuffix("/Patient") { return (200, Self.patientBundle, [:]) }
            if path.hasSuffix("/Observation"), method == "POST" {
                reachedObservationPost.fulfill()
                gate.wait() // hold the drain here while the live tap lands
                return (201, Self.observationBody, [:])
            }
            if path.hasSuffix("/MedicationAdministration") {
                if method == "GET" { return (200, Self.emptyBundle, [:]) }
                adminWrites += 1
                return (201, Self.adminBody, [:])
            }
            return (200, Self.emptyBundle, [:])
        }

        async let report = engine.drain()
        await fulfillment(of: [reachedObservationPost], timeout: 5)
        // The user corrects the slot to 'taken' mid-drain: the live path
        // writes it and purges the queued 'skipped' for the same slot.
        let live = try await engine.logDose(slot: slot, action: .taken)
        XCTAssertFalse(live.wasQueued)
        gate.signal()

        let result = await report
        XCTAssertEqual(result.applied, 1, "only the observations entry replays")
        XCTAssertTrue(result.failures.isEmpty)
        XCTAssertEqual(result.remaining, 0)
        XCTAssertEqual(adminWrites, 1, "the purged 'skipped' entry must never reach the wire")
    }

    /// Bug A, TOCTOU half: a live correction arriving while the SAME slot's
    /// queued entry is already mid-replay (past the re-check, before its
    /// write) must wait for the replay — otherwise whichever server write
    /// lands last wins, and the stale 'skipped' could revert the 'taken'.
    func testLiveDoseWriteLandsAfterInFlightReplayOfSameSlot() async throws {
        let (engine, outbox, _) = makeEngine()
        let slot = sampleSlot()
        await outbox.append(OutboxEntry(kind: .dose(RecordAPI.doseLogPayload(slot: slot, action: .skipped))))

        let reachedAdminSearch = expectation(description: "replay is in flight, before its write")
        let gate = DispatchSemaphore(value: 0)
        var adminSearches = 0
        var writeStatuses: [String] = []
        SyncStubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? "GET"
            if path.hasSuffix("/Patient") { return (200, Self.patientBundle, [:]) }
            if path.hasSuffix("/MedicationAdministration"), method == "GET" {
                adminSearches += 1
                if adminSearches == 1 {
                    reachedAdminSearch.fulfill()
                    gate.wait() // suspend the replay BEFORE its write
                }
                return (200, Self.emptyBundle, [:])
            }
            if path.hasSuffix("/MedicationAdministration"), method == "POST" {
                let body = SyncStubURLProtocol.bodyData(of: request)
                let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                writeStatuses.append(json?["status"] as? String ?? "?")
                return (201, Self.adminBody, [:])
            }
            return (200, Self.emptyBundle, [:])
        }

        async let report = engine.drain()
        await fulfillment(of: [reachedAdminSearch], timeout: 5)
        // Tap 'taken' while the queued 'skipped' replay is in flight …
        let liveTask = _Concurrency.Task { try await engine.logDose(slot: slot, action: .taken) }
        // … and give the live path every chance to (wrongly) race ahead.
        try await _Concurrency.Task.sleep(nanoseconds: 200_000_000)
        gate.signal()
        _ = try await liveTask.value
        _ = await report

        XCTAssertEqual(writeStatuses, ["not-done", "completed"],
                       "the replayed 'skipped' must land first, the live correction last")
    }

    /// Bug B: a malformed reply (captive portal returning 200 + HTML) is not
    /// a server verdict on the payload — the entry must stay queued instead
    /// of the whole outbox being dropped in one pass.
    func testDrainKeepsEntryOnMalformedResponse() async {
        let (engine, outbox, _) = makeEngine()
        await queuedObservationsEntry(outbox)
        SyncStubURLProtocol.handler = { _ in (200, Data("<html>hotel wifi</html>".utf8), [:]) }

        let report = await engine.drain()
        XCTAssertEqual(report.applied, 0)
        XCTAssertTrue(report.failures.isEmpty, "no drop on a reply we could not even parse")
        XCTAssertEqual(report.remaining, 1)
    }

    /// Bug B: the patient lookup coming up empty (seed not run, transient
    /// empty search) happens BEFORE the write is attempted — transient, keep.
    func testDrainKeepsEntryWhenPatientLookupComesUpEmpty() async {
        let (engine, outbox, _) = makeEngine()
        await queuedObservationsEntry(outbox)
        SyncStubURLProtocol.handler = { _ in (200, Self.emptyBundle, [:]) }

        let report = await engine.drain()
        XCTAssertEqual(report.applied, 0)
        XCTAssertTrue(report.failures.isEmpty)
        XCTAssertEqual(report.remaining, 1)
    }

    /// A validation 4xx raised by the write itself IS a definitive server
    /// verdict: drop the entry and surface it loudly.
    func testDrainDropsEntryOnValidation400FromWrite() async {
        let (engine, outbox, _) = makeEngine()
        await queuedObservationsEntry(outbox)
        SyncStubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/Patient") { return (200, Self.patientBundle, [:]) }
            let outcome = #"{"resourceType":"OperationOutcome","issue":[{"severity":"error","details":{"text":"Invalid resource"}}]}"#
            return (400, Data(outcome.utf8), [:])
        }

        let report = await engine.drain()
        XCTAssertEqual(report.applied, 0)
        XCTAssertEqual(report.failures.count, 1)
        XCTAssertTrue(report.failures[0].message.contains("400"))
        XCTAssertEqual(report.remaining, 0)
    }

    /// 401 (surfacing as .unauthenticated) stops the drain and keeps the
    /// entry — needing to sign in again must never cost a health write.
    func testDrainKeepsEntryOn401() async {
        let (engine, outbox, _) = makeEngine()
        await queuedObservationsEntry(outbox)
        SyncStubURLProtocol.handler = { _ in (401, Data("{}".utf8), [:]) }

        let report = await engine.drain()
        XCTAssertEqual(report.applied, 0)
        XCTAssertTrue(report.failures.isEmpty)
        XCTAssertEqual(report.remaining, 1)
    }

    /// Bug B: a token-refresh failure that is NOT a definitive rejection of
    /// the refresh token (here a proxy-ish 403 from oauth2/token) must stop
    /// the drain WITHOUT consuming the entry — and without wiping the session.
    func testDrainKeepsEntryWhenTokenRefreshMisbehaves() async {
        let (engine, outbox, client) = makeEngine()
        await queuedObservationsEntry(outbox)
        SyncStubURLProtocol.handler = { request in
            if (request.url?.path ?? "").hasSuffix("oauth2/token") {
                return (403, Data("{}".utf8), [:])
            }
            return (401, Data("{}".utf8), [:]) // forces the refresh attempt
        }

        let report = await engine.drain()
        XCTAssertEqual(report.applied, 0)
        XCTAssertTrue(report.failures.isEmpty)
        XCTAssertEqual(report.remaining, 1)
        let stillAuthed = await client.isAuthenticated
        XCTAssertTrue(stillAuthed, "an odd token-endpoint status must not destroy the session")
    }
}

/// Wire stub for the drain tests. Unlike StubURLProtocol (MedplumClientTests)
/// the handler runs OFF the loading thread, so a handler that deliberately
/// blocks on a semaphore — how these tests pin actor interleavings — never
/// stalls other in-flight stubbed requests. Not `final` because URLProtocol's
/// required overrides are `class func`s.
class SyncStubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data, [String: String]))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    /// URLSession delivers POST bodies to protocols as a stream, not
    /// `httpBody` — slurp it so handlers can assert on what was written.
    static func bodyData(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let request = self.request
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let (status, body, headers) = try handler(request)
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: status,
                    httpVersion: "HTTP/1.1",
                    headerFields: headers
                )!
                self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                self.client?.urlProtocol(self, didLoad: body)
                self.client?.urlProtocolDidFinishLoading(self)
            } catch {
                self.client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }

    override func stopLoading() {}
}
