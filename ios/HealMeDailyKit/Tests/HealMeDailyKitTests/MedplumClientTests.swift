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
    private func makeClient() -> MedplumClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: config)
        let store = InMemoryTokenStore()
        store.save(TokenSet(
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresAt: Date().addingTimeInterval(3600),
            baseURL: "https://example.test/"
        ))
        return MedplumClient(baseURL: URL(string: "https://example.test/")!, tokenStore: store, session: session)
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
