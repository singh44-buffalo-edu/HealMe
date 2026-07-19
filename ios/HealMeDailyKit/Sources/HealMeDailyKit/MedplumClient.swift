import Foundation
import CryptoKit
import Security

// MARK: - Errors

public enum MedplumError: LocalizedError, Sendable {
    /// No valid session (never signed in, or refresh failed) — the app
    /// responds by showing the sign-in screen.
    case unauthenticated
    case http(status: Int, message: String)
    case network(String)
    case invalidResponse(String)

    public var errorDescription: String? {
        switch self {
        case .unauthenticated:
            return "Signed out — please sign in again."
        case .http(let status, let message):
            return "\(message) (HTTP \(status))"
        case .network(let message):
            return "Cannot reach the Medplum server — \(message)"
        case .invalidResponse(let message):
            return message
        }
    }
}

// MARK: - Token storage

public struct TokenSet: Codable, Sendable {
    public var accessToken: String
    public var refreshToken: String?
    public var expiresAt: Date
    /// Tokens are only valid against the server that minted them; changing
    /// the server URL in Settings invalidates the stored session.
    public var baseURL: String

    public init(accessToken: String, refreshToken: String?, expiresAt: Date, baseURL: String) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.baseURL = baseURL
    }
}

public protocol TokenStore: Sendable {
    func load() -> TokenSet?
    func save(_ tokens: TokenSet)
    func clear()
}

/// Keychain-backed token storage (kSecClassGenericPassword). Health-record
/// session tokens never live in UserDefaults or files.
public struct KeychainTokenStore: TokenStore {
    private let service: String
    private let account = "medplum-session"

    public init(service: String = "com.healmedaily.app") {
        self.service = service
    }

    public func load() -> TokenSet? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(TokenSet.self, from: data)
    }

    public func save(_ tokens: TokenSet) {
        guard let data = try? JSONEncoder().encode(tokens) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // Available after first unlock so background refresh works, but
            // never migrates to another device via backup.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            attributes.forEach { add[$0.key] = $0.value }
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    public func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// In-memory store for unit tests.
public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private var tokens: TokenSet?
    private let lock = NSLock()

    public init() {}

    public func load() -> TokenSet? {
        lock.withLock { tokens }
    }

    public func save(_ tokens: TokenSet) {
        lock.withLock { self.tokens = tokens }
    }

    public func clear() {
        lock.withLock { tokens = nil }
    }
}

// MARK: - Client

/// Async Medplum FHIR client — the iOS counterpart of `@medplum/core`'s
/// MedplumClient, scoped to what this app needs:
///
/// - Sign-in via Medplum's password login + PKCE code exchange
///   (`/auth/login` with an S256 codeChallenge, then `/oauth2/token` with the
///   code_verifier — CLAUDE.md §9: skipping PKCE yields "Missing verification
///   context"). Uses the server's default public client, same as the web
///   frontend's SignInForm.
/// - Tokens live in the Keychain; requests auto-refresh once on 401, then
///   surface `.unauthenticated` so the UI can re-prompt.
/// - Idempotent-write primitives the data layer depends on: conditional
///   create (`If-None-Exist`) and update-in-place.
public actor MedplumClient {
    public let baseURL: URL
    private let store: TokenStore
    private let session: URLSession
    private var tokens: TokenSet?
    /// Coalesces concurrent refreshes so parallel 401s trigger ONE token call.
    private var refreshTask: _Concurrency.Task<TokenSet, Error>?

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    public init(baseURL: URL, tokenStore: TokenStore = KeychainTokenStore(), session: URLSession = .shared) {
        // Normalize to a trailing slash so URL(string:relativeTo:) appends
        // instead of replacing the last path component.
        var normalized = baseURL.absoluteString
        if !normalized.hasSuffix("/") { normalized += "/" }
        self.baseURL = URL(string: normalized) ?? baseURL
        self.store = tokenStore
        self.session = session
        // Only adopt stored tokens minted by THIS server.
        if let stored = tokenStore.load(), stored.baseURL == normalized {
            self.tokens = stored
        }
    }

    public var isAuthenticated: Bool {
        tokens != nil
    }

    // MARK: Sign in / out

    private struct LoginResponse: Decodable {
        struct Membership: Decodable {
            struct Profile: Decodable {
                var reference: String?
                var display: String?
            }
            var id: String?
            var profile: Profile?
        }
        var login: String?
        var code: String?
        var memberships: [Membership]?
    }

    private struct TokenResponse: Decodable {
        var access_token: String
        var refresh_token: String?
        var expires_in: Double?
    }

    /// Password sign-in with PKCE. Single-user app: when the account has
    /// multiple profile memberships the first one is selected automatically.
    public func signIn(email: String, password: String) async throws {
        let verifier = Self.randomVerifier()
        let challenge = Self.s256Challenge(verifier)

        var login: LoginResponse = try await postJSON(
            path: "auth/login",
            body: [
                "email": email,
                "password": password,
                "codeChallenge": challenge,
                "codeChallengeMethod": "S256",
                "scope": "openid offline",
            ]
        )

        if login.code == nil, let loginId = login.login, let membership = login.memberships?.first?.id {
            login = try await postJSON(
                path: "auth/profile",
                body: ["login": loginId, "profile": membership]
            )
        }

        guard let code = login.code else {
            throw MedplumError.invalidResponse("Sign-in did not return an authorization code")
        }

        let token: TokenResponse = try await postForm(
            path: "oauth2/token",
            fields: [
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": verifier,
            ]
        )
        adopt(token)
    }

    public func signOut() {
        tokens = nil
        refreshTask = nil
        store.clear()
    }

    /// Current valid access token (proactively refreshed near expiry) — for
    /// forwarding to the ai-service's session gate. nil when signed out or
    /// when a refresh is impossible right now.
    public func bearerToken() async -> String? {
        try? await currentAccessToken()
    }

    /// Display name of the signed-in profile (GET auth/me).
    public func profileDisplayName() async throws -> String {
        let data = try await authorizedRequest(path: "auth/me", method: "GET", body: nil, contentType: nil, extraHeaders: [:])
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        if let profile = value["profile"] {
            if let display = profile["display"]?.stringValue { return display }
            if case .array(let names)? = profile["name"], case .object(let name)? = names.first {
                var parts: [String] = []
                if case .array(let given)? = name["given"] {
                    parts += given.compactMap { $0.stringValue }
                }
                if let family = name["family"]?.stringValue { parts.append(family) }
                if !parts.isEmpty { return parts.joined(separator: " ") }
            }
        }
        return "Owner"
    }

    // MARK: FHIR REST

    /// GET {base}fhir/R4/{type}?{params}. Params are (name, value) pairs so
    /// repeated names (e.g. two `date` bounds) work.
    public func search(_ type: String, _ params: [(String, String)]) async throws -> FHIRBundle {
        var components = URLComponents()
        components.path = "fhir/R4/\(type)"
        components.queryItems = params.map { URLQueryItem(name: $0.0, value: $0.1) }
        let path = components.string ?? "fhir/R4/\(type)"
        let data = try await authorizedRequest(path: path, method: "GET", body: nil, contentType: nil, extraHeaders: [:])
        return try Self.decode(FHIRBundle.self, from: data)
    }

    /// Typed convenience over `search`.
    public func searchResources<T: FHIRResource>(_ type: T.Type, _ params: [(String, String)]) async throws -> [T] {
        try await search(T.resourceType, params).resources(type)
    }

    public func searchOne<T: FHIRResource>(_ type: T.Type, _ params: [(String, String)]) async throws -> T? {
        var bounded = params
        bounded.append(("_count", "1"))
        return try await searchResources(type, bounded).first
    }

    /// Follow `Bundle.link.next` until exhausted (page cap is a runaway
    /// guard, not a truncation policy — adherence windows must be complete).
    public func searchAll<T: FHIRResource>(_ type: T.Type, _ params: [(String, String)], maxPages: Int = 20) async throws -> [T] {
        var bundle = try await search(T.resourceType, params)
        var out = bundle.resources(type)
        var pages = 1
        while let next = bundle.nextLink, pages < maxPages {
            let data = try await authorizedAbsoluteGET(urlString: next)
            bundle = try Self.decode(FHIRBundle.self, from: data)
            out += bundle.resources(type)
            pages += 1
        }
        return out
    }

    public func read<T: FHIRResource>(_ type: T.Type, id: String) async throws -> T {
        let data = try await authorizedRequest(path: "fhir/R4/\(T.resourceType)/\(id)", method: "GET", body: nil, contentType: nil, extraHeaders: [:])
        return try Self.decode(T.self, from: data)
    }

    public func create<T: FHIRResource>(_ resource: T) async throws -> T {
        let body = try Self.encoder.encode(resource)
        let data = try await authorizedRequest(path: "fhir/R4/\(T.resourceType)", method: "POST", body: body, contentType: "application/fhir+json", extraHeaders: [:])
        return try Self.decode(T.self, from: data)
    }

    /// Conditional create: `If-None-Exist` makes concurrent retries converge
    /// on one resource instead of duplicating (CLAUDE.md §6 idempotency).
    public func createIfNoneExist<T: FHIRResource>(_ resource: T, query: String) async throws -> T {
        let body = try Self.encoder.encode(resource)
        let data = try await authorizedRequest(
            path: "fhir/R4/\(T.resourceType)",
            method: "POST",
            body: body,
            contentType: "application/fhir+json",
            extraHeaders: ["If-None-Exist": query]
        )
        return try Self.decode(T.self, from: data)
    }

    public func update<T: FHIRResource>(_ resource: T) async throws -> T {
        try await update(resource, ifMatchVersion: nil)
    }

    /// Version-checked update: sends `If-Match: W/"<versionId>"` so a
    /// concurrent writer surfaces as HTTP 412 instead of a lost update
    /// (FHIR-MAPPING.md §5 read-modify-write convention). Pass nil to skip
    /// the check (plain PUT).
    public func update<T: FHIRResource>(_ resource: T, ifMatchVersion versionId: String?) async throws -> T {
        guard let id = resource.id else {
            throw MedplumError.invalidResponse("Cannot update a resource without an id")
        }
        var headers: [String: String] = [:]
        if let versionId {
            headers["If-Match"] = "W/\"\(versionId)\""
        }
        let body = try Self.encoder.encode(resource)
        let data = try await authorizedRequest(path: "fhir/R4/\(T.resourceType)/\(id)", method: "PUT", body: body, contentType: "application/fhir+json", extraHeaders: headers)
        return try Self.decode(T.self, from: data)
    }

    public func delete(_ resourceType: String, id: String) async throws {
        _ = try await authorizedRequest(path: "fhir/R4/\(resourceType)/\(id)", method: "DELETE", body: nil, contentType: nil, extraHeaders: [:])
    }

    /// POST a transaction Bundle to {base}fhir/R4 (multi-resource writes).
    /// ⚠️ Check every entry's response.status — Medplum commits valid entries
    /// even when another entry 400s (CLAUDE.md §9 gotcha).
    public func transaction(_ bundle: FHIRBundle) async throws -> FHIRBundle {
        let body = try Self.encoder.encode(bundle)
        let data = try await authorizedRequest(path: "fhir/R4", method: "POST", body: body, contentType: "application/fhir+json", extraHeaders: [:])
        return try Self.decode(FHIRBundle.self, from: data)
    }

    // MARK: - Internals

    private func adopt(_ token: TokenResponse) {
        let set = TokenSet(
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            expiresAt: Date().addingTimeInterval(token.expires_in ?? 3600),
            baseURL: baseURL.absoluteString
        )
        tokens = set
        store.save(set)
    }

    private func currentAccessToken() async throws -> String {
        guard let tokens else { throw MedplumError.unauthenticated }
        // Proactive refresh 60s before expiry avoids a doomed round trip.
        if tokens.expiresAt.timeIntervalSinceNow < 60, tokens.refreshToken != nil {
            return try await refreshedTokens().accessToken
        }
        return tokens.accessToken
    }

    private func refreshedTokens() async throws -> TokenSet {
        if let running = refreshTask {
            return try await running.value
        }
        guard let refresh = tokens?.refreshToken else {
            signOut()
            throw MedplumError.unauthenticated
        }
        let task = _Concurrency.Task<TokenSet, Error> { [weak self] in
            guard let self else { throw MedplumError.unauthenticated }
            let token: TokenResponse = try await self.postForm(
                path: "oauth2/token",
                fields: ["grant_type": "refresh_token", "refresh_token": refresh]
            )
            return await self.adoptAndReturn(token)
        }
        refreshTask = task
        defer { refreshTask = nil }
        do {
            return try await task.value
        } catch {
            // Sign out (wiping the Keychain session) ONLY when the token
            // endpoint definitively rejected the refresh token. A transient
            // network failure must never destroy the session — the request
            // fails, the user retries when connectivity returns.
            switch error {
            case MedplumError.http(let status, _) where status == 400 || status == 401:
                signOut()
                throw MedplumError.unauthenticated
            case MedplumError.unauthenticated:
                signOut()
                throw MedplumError.unauthenticated
            default:
                throw error
            }
        }
    }

    private func adoptAndReturn(_ token: TokenResponse) -> TokenSet {
        adopt(token)
        return tokens!
    }

    private func authorizedRequest(
        path: String,
        method: String,
        body: Data?,
        contentType: String?,
        extraHeaders: [String: String]
    ) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw MedplumError.invalidResponse("Bad request path: \(path)")
        }
        return try await authorizedURLRequest(url: url, method: method, body: body, contentType: contentType, extraHeaders: extraHeaders)
    }

    private func authorizedAbsoluteGET(urlString: String) async throws -> Data {
        guard let url = URL(string: urlString) else {
            throw MedplumError.invalidResponse("Bad pagination link")
        }
        return try await authorizedURLRequest(url: url, method: "GET", body: nil, contentType: nil, extraHeaders: [:])
    }

    private func authorizedURLRequest(
        url: URL,
        method: String,
        body: Data?,
        contentType: String?,
        extraHeaders: [String: String]
    ) async throws -> Data {
        func build(token: String) -> URLRequest {
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.httpBody = body
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/fhir+json", forHTTPHeaderField: "Accept")
            if let contentType {
                request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            }
            extraHeaders.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
            return request
        }

        let token = try await currentAccessToken()
        let (data, response) = try await perform(build(token: token))
        if response.statusCode == 401 {
            // Refresh once, retry once (CLAUDE.md §6 token convention).
            let fresh = try await refreshedTokens()
            let (retryData, retryResponse) = try await perform(build(token: fresh.accessToken))
            if retryResponse.statusCode == 401 {
                signOut()
                throw MedplumError.unauthenticated
            }
            try Self.throwOnError(retryResponse, retryData)
            return retryData
        }
        try Self.throwOnError(response, data)
        return data
    }

    private func postJSON<T: Decodable>(path: String, body: [String: String]) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw MedplumError.invalidResponse("Bad request path: \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await perform(request)
        try Self.throwOnError(response, data)
        return try Self.decode(T.self, from: data)
    }

    private func postForm<T: Decodable>(path: String, fields: [String: String]) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw MedplumError.invalidResponse("Bad request path: \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = fields
            .map { "\($0.key)=\(Self.formEncode($0.value))" }
            .joined(separator: "&")
            .data(using: .utf8)
        let (data, response) = try await perform(request)
        try Self.throwOnError(response, data)
        return try Self.decode(T.self, from: data)
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw MedplumError.invalidResponse("Non-HTTP response")
            }
            return (data, http)
        } catch let error as MedplumError {
            throw error
        } catch {
            throw MedplumError.network(error.localizedDescription)
        }
    }

    private static func throwOnError(_ response: HTTPURLResponse, _ data: Data) throws {
        guard !(200 ... 299).contains(response.statusCode) else { return }
        if response.statusCode == 401 {
            throw MedplumError.unauthenticated
        }
        var message = HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
        if let outcome = try? JSONDecoder().decode(OperationOutcome.self, from: data),
           let detail = outcome.message {
            message = detail
        } else if let body = String(data: data, encoding: .utf8), !body.isEmpty, body.count < 500 {
            message = body
        }
        throw MedplumError.http(status: response.statusCode, message: message)
    }

    private static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw MedplumError.invalidResponse("Could not decode server response: \(error.localizedDescription)")
        }
    }

    // MARK: PKCE helpers

    static func randomVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            // Never keep the all-zero buffer: a predictable code_verifier defeats
            // PKCE entirely. Fall back to the system CSPRNG rather than ship zeros.
            var rng = SystemRandomNumberGenerator()
            bytes = (0 ..< bytes.count).map { _ in UInt8.random(in: .min ... .max, using: &rng) }
        }
        return base64URL(Data(bytes))
    }

    static func s256Challenge(_ verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return base64URL(Data(digest))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func formEncode(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
