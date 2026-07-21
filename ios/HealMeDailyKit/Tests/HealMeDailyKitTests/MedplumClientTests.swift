import XCTest
@testable import HealMeDailyKit

/// Wire-behavior tests for MedplumClient using a stub URLProtocol — no
/// network, fully deterministic. These pin the contract the whole data layer
/// (and its offline replay) leans on: bearer auth, conditional-create /
/// version-checked-update headers, and the refresh-once-on-401 dance.
final class MedplumClientTests: XCTestCase {

    override func setUp() {
        super.setUp()
        StubURLProtocol.handler = nil
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    /// A MedplumClient whose URLSession routes through StubURLProtocol, seeded
    /// with a valid (non-expiring) token so requests are authorized.
    private func makeClient(baseURL: String = "https://example.test/") -> MedplumClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: config)
        let store = InMemoryTokenStore()
        store.save(TokenSet(
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresAt: Date().addingTimeInterval(3600),
            baseURL: baseURL
        ))
        return MedplumClient(baseURL: URL(string: baseURL)!, tokenStore: store, session: session)
    }

    private func okObservation(id: String = "obs-1") -> Data {
        Data(#"{"resourceType":"Observation","id":"\#(id)","status":"final"}"#.utf8)
    }

    func testRequestsCarryBearerToken() async throws {
        var seenAuth: String?
        StubURLProtocol.handler = { request in
            seenAuth = request.value(forHTTPHeaderField: "Authorization")
            return (200, self.okObservation(), [:])
        }
        let client = makeClient()
        _ = try await client.read(FHIRObservation.self, id: "obs-1")
        XCTAssertEqual(seenAuth, "Bearer access-1")
    }

    func testCreateIfNoneExistSendsHeader() async throws {
        var seenIfNoneExist: String?
        StubURLProtocol.handler = { request in
            seenIfNoneExist = request.value(forHTTPHeaderField: "If-None-Exist")
            return (201, self.okObservation(), [:])
        }
        let client = makeClient()
        var obs = FHIRObservation(status: "final")
        obs.identifier = [Identifier(system: "sys", value: "v1")]
        _ = try await client.createIfNoneExist(obs, query: "identifier=sys|v1")
        XCTAssertEqual(seenIfNoneExist, "identifier=sys|v1")
    }

    func testVersionedUpdateSendsWeakETagIfMatch() async throws {
        var seenIfMatch: String?
        StubURLProtocol.handler = { request in
            seenIfMatch = request.value(forHTTPHeaderField: "If-Match")
            return (200, self.okObservation(), [:])
        }
        let client = makeClient()
        var obs = FHIRObservation(status: "final")
        obs.id = "obs-1"
        _ = try await client.update(obs, ifMatchVersion: "3")
        XCTAssertEqual(seenIfMatch, #"W/"3""#)
    }

    func testPlainUpdateSendsNoIfMatch() async throws {
        var hadIfMatch = true
        StubURLProtocol.handler = { request in
            hadIfMatch = request.value(forHTTPHeaderField: "If-Match") != nil
            return (200, self.okObservation(), [:])
        }
        let client = makeClient()
        var obs = FHIRObservation(status: "final")
        obs.id = "obs-1"
        _ = try await client.update(obs)
        XCTAssertFalse(hadIfMatch)
    }

    func testRefreshesOnceOn401ThenRetries() async throws {
        // First protected call 401s; the client should hit oauth2/token then
        // retry the original request with the refreshed token and succeed.
        var tokenCalls = 0
        var protectedCalls = 0
        StubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("oauth2/token") {
                tokenCalls += 1
                let body = Data(#"{"access_token":"access-2","refresh_token":"refresh-2","expires_in":3600}"#.utf8)
                return (200, body, [:])
            }
            protectedCalls += 1
            if protectedCalls == 1 {
                return (401, Data("{}".utf8), [:])
            }
            return (200, self.okObservation(), [:])
        }
        let client = makeClient()
        let result = try await client.read(FHIRObservation.self, id: "obs-1")
        XCTAssertEqual(result.id, "obs-1")
        XCTAssertEqual(tokenCalls, 1, "exactly one refresh")
        XCTAssertEqual(protectedCalls, 2, "original + one retry")
    }

    func testSecond401AfterRefreshSignsOut() async {
        // Refresh succeeds but the retry still 401s → the client gives up with
        // .unauthenticated (the UI then re-prompts sign-in).
        StubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("oauth2/token") {
                return (200, Data(#"{"access_token":"a2","expires_in":3600}"#.utf8), [:])
            }
            return (401, Data("{}".utf8), [:])
        }
        let client = makeClient()
        do {
            _ = try await client.read(FHIRObservation.self, id: "obs-1")
            XCTFail("expected unauthenticated")
        } catch let error as MedplumError {
            guard case .unauthenticated = error else {
                return XCTFail("expected .unauthenticated, got \(error)")
            }
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testTransientNetworkErrorDoesNotSignOut() async {
        // A refresh that fails with a NETWORK error (not 400/401) must NOT
        // destroy the session — the request fails, retry later.
        StubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("oauth2/token") {
                throw URLError(.notConnectedToInternet)
            }
            return (401, Data("{}".utf8), [:])
        }
        let client = makeClient()
        do {
            _ = try await client.read(FHIRObservation.self, id: "obs-1")
            XCTFail("expected an error")
        } catch {
            // Session preserved: still authenticated after a transient failure.
            let stillAuthed = await client.isAuthenticated
            XCTAssertTrue(stillAuthed, "a network blip must not wipe the session")
        }
    }

    // MARK: Pagination link rebasing (server base URL ≠ client base URL)

    func testSearchAllRebasesNextLinkOntoClientBaseURL() async throws {
        // Medplum stamps Bundle.link.next with ITS OWN MEDPLUM_BASE_URL
        // (e.g. http://localhost:8103/); the phone reaches the server at a
        // different address (Tailscale IP). Page 2 must be fetched from the
        // client's baseURL host with the link's path + query — never from
        // the host the response named.
        var seenRequests: [URLRequest] = []
        StubURLProtocol.handler = { request in
            seenRequests.append(request)
            if seenRequests.count == 1 {
                let page1 = """
                {"resourceType":"Bundle","type":"searchset",
                 "link":[{"relation":"next","url":"http://localhost:8103/fhir/R4/Observation?_offset=20&_count=20"}],
                 "entry":[{"resource":{"resourceType":"Observation","id":"obs-1","status":"final"}}]}
                """
                return (200, Data(page1.utf8), [:])
            }
            let page2 = #"{"resourceType":"Bundle","type":"searchset","entry":[{"resource":{"resourceType":"Observation","id":"obs-2","status":"final"}}]}"#
            return (200, Data(page2.utf8), [:])
        }
        let client = makeClient()
        let results = try await client.searchAll(FHIRObservation.self, [("code", "x")])
        XCTAssertEqual(results.map(\.id), ["obs-1", "obs-2"])
        XCTAssertEqual(seenRequests.count, 2, "first page + one rebased next page")
        let page2URL = try XCTUnwrap(seenRequests.last?.url)
        XCTAssertEqual(page2URL.scheme, "https")
        XCTAssertEqual(page2URL.host, "example.test")
        XCTAssertEqual(page2URL.path, "/fhir/R4/Observation")
        XCTAssertEqual(page2URL.query, "_offset=20&_count=20")
        // The bearer token went to OUR host on every page, nowhere else.
        for request in seenRequests {
            XCTAssertEqual(request.url?.host, "example.test")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-1")
        }
    }

    func testSearchAllKeepsBaseURLPathPrefixWhenRebasing() async throws {
        // A reverse-proxied base (https://host/medplum/) must keep its path
        // prefix when the stamped link only carries /fhir/R4/…
        var seenPaths: [String] = []
        StubURLProtocol.handler = { request in
            seenPaths.append(request.url?.path ?? "")
            if seenPaths.count == 1 {
                let page1 = """
                {"resourceType":"Bundle","type":"searchset",
                 "link":[{"relation":"next","url":"http://localhost:8103/fhir/R4/Observation?_offset=20"}],
                 "entry":[]}
                """
                return (200, Data(page1.utf8), [:])
            }
            return (200, Data(#"{"resourceType":"Bundle","type":"searchset"}"#.utf8), [:])
        }
        let client = makeClient(baseURL: "https://example.test/medplum/")
        _ = try await client.searchAll(FHIRObservation.self, [])
        XCTAssertEqual(seenPaths, ["/medplum/fhir/R4/Observation", "/medplum/fhir/R4/Observation"])
    }

    func testAbsoluteGETRefusesForeignHost() async {
        // Defense in depth behind the rebase: even if a foreign absolute URL
        // reaches the authorized-GET path, no request — and therefore no
        // bearer token — may leave for a host other than the configured one.
        var sawRequest = false
        StubURLProtocol.handler = { _ in
            sawRequest = true
            return (200, Data("{}".utf8), [:])
        }
        let client = makeClient()
        do {
            _ = try await client.authorizedAbsoluteGET(urlString: "https://evil.example/fhir/R4/Observation?_offset=20")
            XCTFail("expected a refusal")
        } catch let error as MedplumError {
            guard case .invalidResponse = error else {
                return XCTFail("expected .invalidResponse, got \(error)")
            }
        } catch {
            XCTFail("unexpected error \(error)")
        }
        XCTAssertFalse(sawRequest, "no request may be sent to a foreign host")
    }
}

/// Minimal in-process URL stub: each test sets `handler` to map a request to
/// (status, body, headers) or throw a transport error. Not `final` because
/// URLProtocol's required overrides are `class func`s.
class StubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data, [String: String]))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (status, body, headers) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
