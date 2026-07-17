import Foundation

/// Typed client for the local Python ai-service (FastAPI :8000) — the iOS
/// counterpart of `frontend/src/api.ts`. FHIR CRUD does NOT go through here;
/// views use RecordAPI/MedplumClient directly.
///
/// Safety invariants behind these endpoints (enforced server-side; the UI
/// must not paper over them): AI/OCR extractions only ever become clinical
/// resources through the review queue's approve step; AI answers always
/// carry citations + the not-medical-advice disclaimer; data is never sent
/// to an unconfigured provider; every cloud call is preceded by a
/// boundary-ledger AuditEvent.
public struct AIService: Sendable {
    public let baseURL: URL
    private let session: URLSession
    /// Supplies the caller's Medplum access token: the ai-service requires it
    /// on every endpoint except /health (its session gate). Async so the
    /// provider can refresh a near-expiry token first. nil ⇒ no header (the
    /// service answers 401 and the UI shows its message).
    public var tokenProvider: (@Sendable () async -> String?)?

    public init(baseURL: URL, session: URLSession = .shared) {
        var normalized = baseURL.absoluteString
        if !normalized.hasSuffix("/") { normalized += "/" }
        self.baseURL = URL(string: normalized) ?? baseURL
        self.session = session
    }

    public enum ServiceError: LocalizedError {
        /// Connection-level failure — the friendly "is the service running" state.
        case unreachable
        case http(status: Int, detail: String)
        case decoding(String)

        public var errorDescription: String? {
            switch self {
            case .unreachable:
                return "AI service is not reachable — is it running on the server?"
            case .http(_, let detail):
                return detail
            case .decoding(let message):
                return message
            }
        }
    }

    // MARK: Models (mirror api.ts)

    public struct AiStatus: Codable, Sendable {
        public var provider: String?
        public var model: String?
        public var configured: Bool
        public var reason: String?
    }

    public struct Health: Codable, Sendable {
        public var status: String
        public var medplum_configured: Bool
        public var ai: AiStatus
    }

    public struct ReviewResult: Codable, Sendable, Identifiable {
        public var document_reference_id: String
        public var generated_at: String
        public var window_days: Int?
        public var description: String?
        public var markdown: String

        public var id: String { document_reference_id }
    }

    public struct UploadResult: Codable, Sendable {
        public var document_reference_id: String
        public var document_kind: String?
        public var extraction_method: String
        public var text_chars: Int
        public var proposals_created: Int
        public var note: String?
    }

    public struct ImportResult: Codable, Sendable {
        public var imported: Int
        public var already_existed: Int
        public var prepared: Int
        public var skipped: [String: Int]
    }

    public struct ReviewTask: Codable, Sendable, Identifiable {
        public var task_id: String
        public var description: String
        public var confidence: Double?
        public var source_excerpt: String?
        public var document_reference: String?
        public var authored_on: String?
        public var resource: JSONValue?

        public var id: String { task_id }
    }

    public enum AiRoute: String, Codable, Sendable, CaseIterable {
        case local
        case cloud
        case off
    }

    public struct AiProviderInfo: Codable, Sendable, Identifiable {
        public var name: String
        public var is_local: Bool
        public var configured: Bool
        public var model: String
        public var masked_key: String?
        public var base_url: String?

        public var id: String { name }
    }

    public struct AiSettings: Codable, Sendable {
        public var providers: [AiProviderInfo]
        public var routing: [String: AiRoute]
        public var cloud_provider: String?
    }

    public struct AiTestResult: Codable, Sendable {
        public var ok: Bool
        public var provider: String
        public var model: String?
        public var latency_ms: Double?
        public var reply: String?
        public var reason: String?
    }

    public struct AssistantCitation: Codable, Sendable, Identifiable {
        public var n: Int
        public var resourceType: String
        // Named `resourceId` locally: `id` is claimed by Identifiable.
        public var resourceId: String
        public var display: String
        public var value: String?
        public var date: String?

        enum CodingKeys: String, CodingKey {
            case n, resourceType, display, value, date
            case resourceId = "id"
        }

        public var id: Int { n }
    }

    public struct AssistantAnswer: Codable, Sendable {
        public var answer_markdown: String
        public var citations: [AssistantCitation]
        public var read_count: Int
        public var provider: Provider
        public var communication_id: String
        public var disclaimer: String

        public struct Provider: Codable, Sendable {
            public var name: String
            public var is_local: Bool
        }
    }

    public struct AssistantSession: Codable, Sendable, Identifiable {
        public var id: String
        public var question: String
        public var answer_preview: String
        public var sent: String
    }

    public struct NlImportResult: Codable, Sendable {
        public var proposals: Int
        public var task_ids: [String]
        public var note: String?
    }

    // MARK: Endpoints

    /// Liveness + config probe: is the service up, can it reach Medplum, and
    /// is an AI provider ready. The app must work with no AI configured —
    /// AI surfaces show a "configure a provider" state, never an error wall.
    public func health() async throws -> Health {
        try await get("health")
    }

    /// Generate an AI Health Review (slow — one LLM round trip). Organizes
    /// only, never diagnoses. Each run stores a NEW document.
    public func generateReview(windowDays: Int) async throws -> ReviewResult {
        try await post("health-review", json: ["window_days": windowDays])
    }

    /// Deterministic data-only clinician summary — same shape, no AI at all;
    /// always available even fully offline.
    public func generateDataSummary(windowDays: Int) async throws -> ReviewResult {
        try await post("health-review/data-summary", json: ["window_days": windowDays])
    }

    /// Most recent stored review; 404 when none exists yet.
    public func latestReview() async throws -> ReviewResult {
        try await get("health-review/latest")
    }

    /// Download a stored review PDF (already carries the not-medical-advice
    /// disclaimer server-side). Returns raw bytes for the share sheet.
    public func reviewPdf(documentId: String) async throws -> Data {
        let (data, response) = try await perform(request(path: "health-review/\(documentId)/pdf"))
        try Self.throwOnError(response, data)
        return data
    }

    /// Upload a PDF/photo for OCR/AI extraction. The original is stored
    /// immutably; each candidate becomes a review-queue Task — NOTHING is
    /// committed to the clinical record by this call. Long-running.
    public func uploadDocument(data: Data, filename: String, mimeType: String) async throws -> UploadResult {
        try await postMultipart("ingest/upload", data: data, filename: filename, mimeType: mimeType)
    }

    /// Deterministic structured import (FHIR bundle / CSV / Apple Health /
    /// C-CDA / HL7v2) — commits directly with dedup + Provenance; the review
    /// queue is for AI extractions only.
    public func importStructured(kind: String, data: Data, filename: String, mimeType: String) async throws -> ImportResult {
        try await postMultipart("import/\(kind)", data: data, filename: filename, mimeType: mimeType)
    }

    /// Pending extraction proposals awaiting human review.
    public func listReviewTasks() async throws -> [ReviewTask] {
        try await get("ingest/tasks")
    }

    /// Approve one proposal — the ONLY path by which AI/OCR output becomes a
    /// clinical resource. Passing nil keeps the candidate as extracted.
    public func approveTask(taskId: String, resource: JSONValue?) async throws {
        struct Body: Encodable {
            var resource: JSONValue?
        }
        let payload = try JSONEncoder().encode(Body(resource: resource))
        var req = request(path: "ingest/tasks/\(urlEncode(taskId))/approve")
        req.httpMethod = "POST"
        req.httpBody = payload
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await perform(req)
        try Self.throwOnError(response, data)
    }

    /// Reject a proposal: no clinical resource is ever created.
    public func rejectTask(taskId: String) async throws {
        var req = request(path: "ingest/tasks/\(urlEncode(taskId))/reject")
        req.httpMethod = "POST"
        let (data, response) = try await perform(req)
        try Self.throwOnError(response, data)
    }

    public func aiSettings() async throws -> AiSettings {
        try await get("ai/settings")
    }

    /// Partial-update routing / cloud provider. Setting 'cloud' only routes —
    /// every actual cloud call still writes its boundary AuditEvent.
    public func updateAiSettings(routing: [String: AiRoute]? = nil, cloudProvider: String? = nil) async throws -> AiSettings {
        struct Body: Encodable {
            var routing: [String: AiRoute]?
            var cloud_provider: String?
        }
        var req = request(path: "ai/settings")
        req.httpMethod = "PUT"
        req.httpBody = try JSONEncoder().encode(Body(routing: routing, cloud_provider: cloudProvider))
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await perform(req)
        try Self.throwOnError(response, data)
        return try Self.decode(AiSettings.self, from: data)
    }

    public func testProvider(_ provider: String) async throws -> AiTestResult {
        var req = request(path: "ai/test/\(urlEncode(provider))")
        req.httpMethod = "POST"
        let (data, response) = try await perform(req)
        try Self.throwOnError(response, data)
        return try Self.decode(AiTestResult.self, from: data)
    }

    /// Ask the record-grounded assistant. Read-only over the FHIR record —
    /// it can never write clinical data. Slow (record search + LLM).
    public func askAssistant(question: String) async throws -> AssistantAnswer {
        try await post("assistant/ask", json: ["question": question], timeout: 180)
    }

    public func assistantSessions() async throws -> [AssistantSession] {
        try await get("assistant/sessions")
    }

    public func deleteAssistantSession(id: String) async throws {
        var req = request(path: "assistant/sessions/\(urlEncode(id))")
        req.httpMethod = "DELETE"
        let (data, response) = try await perform(req)
        try Self.throwOnError(response, data)
    }

    /// Natural-language quick capture — proposals ride the SAME review queue
    /// as document ingestion, never a direct commit.
    public func nlImport(text: String) async throws -> NlImportResult {
        try await post("assistant/nl-import", json: ["text": text])
    }

    // MARK: Internals

    private func request(path: String, timeout: TimeInterval = 60) -> URLRequest {
        var req = URLRequest(url: URL(string: path, relativeTo: baseURL) ?? baseURL)
        req.timeoutInterval = timeout
        return req
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, response) = try await perform(request(path: path))
        try Self.throwOnError(response, data)
        return try Self.decode(T.self, from: data)
    }

    private func post<T: Decodable>(_ path: String, json body: [String: some Encodable], timeout: TimeInterval = 120) async throws -> T {
        var req = request(path: path, timeout: timeout)
        req.httpMethod = "POST"
        req.httpBody = try JSONEncoder().encode(body)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await perform(req)
        try Self.throwOnError(response, data)
        return try Self.decode(T.self, from: data)
    }

    private func postMultipart<T: Decodable>(_ path: String, data: Data, filename: String, mimeType: String) async throws -> T {
        let boundary = "hmd-\(UUID().uuidString)"
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var req = request(path: path, timeout: 300) // OCR + model: tens of seconds
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let (responseData, response) = try await perform(req)
        try Self.throwOnError(response, responseData)
        return try Self.decode(T.self, from: responseData)
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        var request = request
        // Session token added here so every call path (GET/POST/multipart)
        // carries it — never in a URL parameter.
        if let tokenProvider, let token = await tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw ServiceError.unreachable
            }
            return (data, http)
        } catch let error as ServiceError {
            throw error
        } catch {
            throw ServiceError.unreachable
        }
    }

    /// Surfaces FastAPI's `{detail}` verbatim so server-side reasons
    /// ("no provider configured", validation) reach the UI.
    private static func throwOnError(_ response: HTTPURLResponse, _ data: Data) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        var detail = "\(response.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: response.statusCode))"
        if let value = try? JSONDecoder().decode(JSONValue.self, from: data),
           let message = value["detail"]?.stringValue {
            detail = message
        }
        throw ServiceError.http(status: response.statusCode, detail: detail)
    }

    private static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ServiceError.decoding("Could not decode ai-service response: \(error.localizedDescription)")
        }
    }

    private func urlEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}
