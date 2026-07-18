import XCTest
@testable import HealMeDailyKit

/// Wire-behavior tests for AIService's BYOK key management, using the shared
/// stub URLProtocol (see MedplumClientTests) — no network, fully deterministic.
/// These pin the contract the Settings "remote control" leans on: bearer auth,
/// the exact /ai/keys paths + methods + JSON body, and that partial settings
/// updates carry base_urls while dropping omitted fields.
final class AIServiceTests: XCTestCase {

    override func setUp() {
        super.setUp()
        StubURLProtocol.handler = nil
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    /// An AIService whose URLSession routes through StubURLProtocol, with a
    /// fixed bearer token so requests are authorized the way perform() does it.
    private func makeService() -> AIService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: config)
        var service = AIService(baseURL: URL(string: "https://example.test/")!, session: session)
        service.tokenProvider = { "test-token" }
        return service
    }

    /// URLProtocol usually moves a request body onto httpBodyStream — read from
    /// whichever the stubbed request carries so body assertions are reliable.
    private func bodyData(_ request: URLRequest) -> Data {
        if let body = request.httpBody {
            return body
        }
        guard let stream = request.httpBodyStream else {
            return Data()
        }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            if read <= 0 {
                break
            }
            data.append(buffer, count: read)
        }
        return data
    }

    func testSetProviderKeySendsBearerBodyPathAndDecodesMaskedKey() async throws {
        var seenAuth: String?
        var seenMethod: String?
        var seenPath: String?
        var seenBody: Data?
        StubURLProtocol.handler = { request in
            seenAuth = request.value(forHTTPHeaderField: "Authorization")
            seenMethod = request.httpMethod
            seenPath = request.url?.path
            seenBody = self.bodyData(request)
            let body = Data(#"{"provider":"anthropic","configured":true,"masked_key":"sk-****abcd"}"#.utf8)
            return (200, body, [:])
        }
        let service = makeService()
        let result = try await service.setProviderKey("anthropic", key: "sk-secret-value")

        // Decodes the server's masked echo (never the raw key).
        XCTAssertEqual(result.masked_key, "sk-****abcd")
        XCTAssertTrue(result.configured)
        XCTAssertEqual(result.provider, "anthropic")

        XCTAssertEqual(seenAuth, "Bearer test-token")
        XCTAssertEqual(seenMethod, "POST")
        XCTAssertEqual(seenPath, "/ai/keys/anthropic")

        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: seenBody ?? Data()) as? [String: Any]
        )
        XCTAssertEqual(json["key"] as? String, "sk-secret-value")
    }

    func testDeleteProviderKeyHitsDeleteWithBearer() async throws {
        var seenAuth: String?
        var seenMethod: String?
        var seenPath: String?
        StubURLProtocol.handler = { request in
            seenAuth = request.value(forHTTPHeaderField: "Authorization")
            seenMethod = request.httpMethod
            seenPath = request.url?.path
            return (200, Data(#"{"provider":"openai","deleted":true,"configured":false}"#.utf8), [:])
        }
        let service = makeService()
        try await service.deleteProviderKey("openai")

        XCTAssertEqual(seenAuth, "Bearer test-token")
        XCTAssertEqual(seenMethod, "DELETE")
        XCTAssertEqual(seenPath, "/ai/keys/openai")
    }

    func testUpdateAiSettingsIncludesBaseUrls() async throws {
        var seenMethod: String?
        var seenBody: Data?
        StubURLProtocol.handler = { request in
            seenMethod = request.httpMethod
            seenBody = self.bodyData(request)
            let payload = Data(#"{"providers":[],"routing":{},"cloud_provider":"openai"}"#.utf8)
            return (200, payload, [:])
        }
        let service = makeService()
        let settings = try await service.updateAiSettings(baseUrls: ["openai": "https://proxy.local/v1"])
        XCTAssertEqual(settings.cloud_provider, "openai")
        XCTAssertEqual(seenMethod, "PUT")

        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: seenBody ?? Data()) as? [String: Any]
        )
        let baseUrls = json["base_urls"] as? [String: String]
        XCTAssertEqual(baseUrls?["openai"], "https://proxy.local/v1")
        // Omitted (nil) fields must be dropped so this stays a partial update.
        XCTAssertNil(json["routing"], "routing omitted ⇒ absent")
        XCTAssertNil(json["cloud_provider"], "cloud_provider omitted ⇒ absent")
    }

    func testUpdateAiSettingsSendsCloudProvider() async throws {
        var seenBody: Data?
        StubURLProtocol.handler = { request in
            seenBody = self.bodyData(request)
            return (200, Data(#"{"providers":[],"routing":{},"cloud_provider":"gemini"}"#.utf8), [:])
        }
        let service = makeService()
        _ = try await service.updateAiSettings(cloudProvider: "gemini")

        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: seenBody ?? Data()) as? [String: Any]
        )
        XCTAssertEqual(json["cloud_provider"] as? String, "gemini")
        XCTAssertNil(json["base_urls"], "base_urls omitted ⇒ absent")
        XCTAssertNil(json["routing"], "routing omitted ⇒ absent")
    }
}
