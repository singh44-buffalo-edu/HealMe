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

    func testOutboxPersistsAcrossReload() async throws {
        let store = OutboxStore(directory: directory)
        let payload = RecordAPI.doseLogPayload(slot: sampleSlot(), action: .taken)
        try await store.append(OutboxEntry(kind: .dose(payload)))
        try await store.append(OutboxEntry(kind: .checkin(CheckinPayload(
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

    func testOutboxRemoveById() async throws {
        let store = OutboxStore(directory: directory)
        let entry = OutboxEntry(kind: .observations(ObservationsPayload(observations: [])))
        try await store.append(entry)
        let count = await store.count
        XCTAssertEqual(count, 1)
        await store.remove(id: entry.id)
        let after = await store.count
        XCTAssertEqual(after, 0)
    }

    func testOutboxRemoveMatchingSupersedesSameSlot() async throws {
        let store = OutboxStore(directory: directory)
        let slot = sampleSlot()
        try await store.append(OutboxEntry(kind: .dose(RecordAPI.doseLogPayload(slot: slot, action: .taken))))
        try await store.append(OutboxEntry(kind: .checkin(CheckinPayload(
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
        // The set-aside is surfaced, not silent — the app shows a notice.
        let flagged = await store.corruptFileSetAside()
        XCTAssertNotNil(flagged)
        XCTAssertTrue(flagged?.hasPrefix("outbox.corrupt-") ?? false)
    }

    func testAppendSurfacesPersistFailureInsteadOfClaimingQueued() async {
        // Occupy the store's directory path with a regular FILE so every
        // queue write must fail: append has to throw, not report success
        // for an entry that exists only in memory.
        try? Data("not a directory".utf8).write(to: directory)
        let store = OutboxStore(directory: directory)
        do {
            try await store.append(OutboxEntry(kind: .observations(ObservationsPayload(observations: []))))
            XCTFail("append must surface a failed persist")
        } catch {
            // expected
        }
        let count = await store.count
        XCTAssertEqual(count, 0, "a failed append leaves nothing half-queued in memory")
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

    private func queuedObservationsEntry(_ outbox: OutboxStore, profileRef: String? = nil) async throws {
        try await outbox.append(OutboxEntry(
            kind: .observations(ObservationsPayload(
                observations: RecordAPI.stampQuickIdentifiers([FHIRObservation(status: "final")])
            )),
            profileRef: profileRef
        ))
    }

    /// Bug A, stale-snapshot half: an entry superseded and purged by a live
    /// write WHILE the drain is replaying an earlier entry must never reach
    /// the wire — replaying it would revert the correction (same identifier,
    /// update-in-place).
    func testDrainSkipsEntryPurgedByLiveWriteMidDrain() async throws {
        let (engine, outbox, _) = makeEngine()
        let slot = sampleSlot()
        try await queuedObservationsEntry(outbox) // replayed first, gated below
        try await outbox.append(OutboxEntry(kind: .dose(RecordAPI.doseLogPayload(slot: slot, action: .skipped))))

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
        try await outbox.append(OutboxEntry(kind: .dose(RecordAPI.doseLogPayload(slot: slot, action: .skipped))))

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
    func testDrainKeepsEntryOnMalformedResponse() async throws {
        let (engine, outbox, _) = makeEngine()
        try await queuedObservationsEntry(outbox)
        SyncStubURLProtocol.handler = { _ in (200, Data("<html>hotel wifi</html>".utf8), [:]) }

        let report = await engine.drain()
        XCTAssertEqual(report.applied, 0)
        XCTAssertTrue(report.failures.isEmpty, "no drop on a reply we could not even parse")
        XCTAssertEqual(report.remaining, 1)
    }

    /// Bug B: the patient lookup coming up empty (seed not run, transient
    /// empty search) happens BEFORE the write is attempted — transient, keep.
    func testDrainKeepsEntryWhenPatientLookupComesUpEmpty() async throws {
        let (engine, outbox, _) = makeEngine()
        try await queuedObservationsEntry(outbox)
        SyncStubURLProtocol.handler = { _ in (200, Self.emptyBundle, [:]) }

        let report = await engine.drain()
        XCTAssertEqual(report.applied, 0)
        XCTAssertTrue(report.failures.isEmpty)
        XCTAssertEqual(report.remaining, 1)
    }

    /// A validation 4xx raised by the write itself IS a definitive server
    /// verdict: drop the entry and surface it loudly.
    func testDrainDropsEntryOnValidation400FromWrite() async throws {
        let (engine, outbox, _) = makeEngine()
        try await queuedObservationsEntry(outbox)
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
    func testDrainKeepsEntryOn401() async throws {
        let (engine, outbox, _) = makeEngine()
        try await queuedObservationsEntry(outbox)
        SyncStubURLProtocol.handler = { _ in (401, Data("{}".utf8), [:]) }

        let report = await engine.drain()
        XCTAssertEqual(report.applied, 0)
        XCTAssertTrue(report.failures.isEmpty)
        XCTAssertEqual(report.remaining, 1)
    }

    /// Bug B: a token-refresh failure that is NOT a definitive rejection of
    /// the refresh token (here a proxy-ish 403 from oauth2/token) must stop
    /// the drain WITHOUT consuming the entry — and without wiping the session.
    func testDrainKeepsEntryWhenTokenRefreshMisbehaves() async throws {
        let (engine, outbox, client) = makeEngine()
        try await queuedObservationsEntry(outbox)
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
        XCTAssertFalse(report.stoppedForAuth, "transient token trouble is not a session verdict")
        let stillAuthed = await client.isAuthenticated
        XCTAssertTrue(stillAuthed, "an odd token-endpoint status must not destroy the session")
    }

    /// A DEFINITIVE refresh-token rejection mid-drain wipes the session
    /// (client-side) — the report must say so, or the app keeps promising
    /// "syncs when your server is reachable" under a dead session forever.
    func testDrainReportsAuthStopWhenRefreshTokenDefinitivelyRejected() async throws {
        let (engine, outbox, client) = makeEngine()
        try await queuedObservationsEntry(outbox)
        SyncStubURLProtocol.handler = { request in
            if (request.url?.path ?? "").hasSuffix("oauth2/token") {
                return (400, Data("{}".utf8), [:]) // definitive rejection
            }
            return (401, Data("{}".utf8), [:]) // forces the refresh attempt
        }

        let report = await engine.drain()
        XCTAssertEqual(report.applied, 0)
        XCTAssertTrue(report.failures.isEmpty, "auth-stop is not a per-entry failure")
        XCTAssertTrue(report.stoppedForAuth, "the caller must learn the session died mid-drain")
        XCTAssertEqual(report.remaining, 1, "the entry stays queued for after the next sign-in")
        let stillAuthed = await client.isAuthenticated
        XCTAssertFalse(stillAuthed, "the client wiped the definitively rejected session")
    }

    /// Entries queued under a DIFFERENT sign-in are held (skipped, kept,
    /// counted) — never replayed into the current session's record and
    /// never auto-discarded. Unstamped (legacy) and matching entries drain.
    func testDrainHoldsEntriesQueuedUnderAnotherProfile() async throws {
        let (engine, outbox, _) = makeEngine()
        try await queuedObservationsEntry(outbox, profileRef: "Patient/p1") // current session
        try await queuedObservationsEntry(outbox, profileRef: "Patient/previous-owner")
        try await queuedObservationsEntry(outbox) // legacy, unstamped
        SyncStubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/Patient") { return (200, Self.patientBundle, [:]) }
            if path.hasSuffix("/Observation"), request.httpMethod == "POST" {
                return (201, Self.observationBody, [:])
            }
            return (200, Self.emptyBundle, [:])
        }

        let report = await engine.drain()
        XCTAssertEqual(report.applied, 2, "matching + unstamped entries replay")
        XCTAssertEqual(report.heldForOtherProfile, 1)
        XCTAssertTrue(report.failures.isEmpty, "held is not failed")
        XCTAssertEqual(report.remaining, 1)
        let remaining = await outbox.all()
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(remaining.first?.profileRef, "Patient/previous-owner")
    }

    /// Identifiers are stamped once per USER ACTION: retrying the same save
    /// after a partial live failure (obs 1 committed, obs 2 rejected) must
    /// reuse the first attempt's identifiers so the committed observation
    /// converges via If-None-Exist instead of duplicating.
    func testQuickObservationIdentifiersStableAcrossRetry() async throws {
        let (engine, _, _) = makeEngine()
        let observations = [FHIRObservation(status: "final"), FHIRObservation(status: "preliminary")]

        var observationPosts = 0
        var postedIdentifiers: [String] = []
        SyncStubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/Patient") { return (200, Self.patientBundle, [:]) }
            if path.hasSuffix("/Observation"), request.httpMethod == "POST" {
                let body = SyncStubURLProtocol.bodyData(of: request)
                let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                let ident = ((json?["identifier"] as? [[String: Any]])?.first?["value"] as? String) ?? "?"
                postedIdentifiers.append(ident)
                observationPosts += 1
                if observationPosts == 2 { return (500, Data("{}".utf8), [:]) } // partial failure
                return (201, Self.observationBody, [:])
            }
            return (200, Self.emptyBundle, [:])
        }

        do {
            _ = try await engine.saveQuickObservations(observations)
            XCTFail("first attempt must surface the second observation's 500")
        } catch {
            // expected — the user sees the failure and retries
        }
        let retry = try await engine.saveQuickObservations(observations)
        XCTAssertFalse(retry.wasQueued)

        XCTAssertEqual(postedIdentifiers.count, 4)
        XCTAssertNotEqual(postedIdentifiers[0], postedIdentifiers[1])
        XCTAssertEqual(postedIdentifiers[2], postedIdentifiers[0],
                       "retry must reuse the committed observation's identifier (converges, no duplicate)")
        XCTAssertEqual(postedIdentifiers[3], postedIdentifiers[1],
                       "retry must reuse the frozen identifier for the observation that failed")
    }

    /// When the offline queue itself cannot persist, the engine must THROW —
    /// returning `.queued` for an entry that exists only in memory would
    /// lose a health write on termination.
    func testEngineSurfacesQueuePersistFailureInsteadOfClaimingQueued() async {
        // Occupy the outbox directory path with a FILE so persists fail.
        try? Data("not a directory".utf8).write(to: directory)
        let (engine, outbox, _) = makeEngine()
        SyncStubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/Patient") { return (200, Self.patientBundle, [:]) }
            throw URLError(.notConnectedToInternet) // offline → queue path
        }

        do {
            _ = try await engine.saveQuickObservations([FHIRObservation(status: "final")])
            XCTFail("a failed queue-persist must never be reported as queued")
        } catch {
            // expected — surfaced to the user as a real failure
        }
        let count = await outbox.count
        XCTAssertEqual(count, 0, "nothing half-queued in memory either")
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
