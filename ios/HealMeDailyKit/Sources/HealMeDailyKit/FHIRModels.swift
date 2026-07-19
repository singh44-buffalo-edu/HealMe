import Foundation

/// Minimal FHIR R4 Codable models — only the resources and fields this app
/// actually reads or writes (FHIR-MAPPING.md is canonical for shapes). All
/// date/time fields stay `String` on purpose: FHIR timestamps carry offsets
/// and precision the Foundation Date round-trip would destroy, and the
/// dose/cadence engines work on calendar strings exactly like the web
/// frontend does. Every struct is tolerant: unknown JSON fields are ignored
/// on decode, and all properties are optional unless FHIR requires them.

// MARK: - Datatypes

public struct Coding: Codable, Hashable, Sendable {
    public var system: String?
    public var code: String?
    public var display: String?

    public init(system: String? = nil, code: String? = nil, display: String? = nil) {
        self.system = system
        self.code = code
        self.display = display
    }
}

public struct CodeableConcept: Codable, Hashable, Sendable {
    public var coding: [Coding]?
    public var text: String?

    public init(coding: [Coding]? = nil, text: String? = nil) {
        self.coding = coding
        self.text = text
    }

    /// First code in the given system, the common lookup everywhere.
    public func code(in system: String) -> String? {
        coding?.first(where: { $0.system == system })?.code
    }
}

public struct Identifier: Codable, Hashable, Sendable {
    public var system: String?
    public var value: String?

    public init(system: String? = nil, value: String? = nil) {
        self.system = system
        self.value = value
    }
}

public struct Reference: Codable, Hashable, Sendable {
    public var reference: String?
    public var display: String?

    public init(reference: String? = nil, display: String? = nil) {
        self.reference = reference
        self.display = display
    }

    /// "Medication/abc" → "abc" (nil when the type doesn't match).
    public func id(ofType type: String) -> String? {
        guard let reference, reference.hasPrefix("\(type)/") else { return nil }
        return String(reference.dropFirst(type.count + 1))
    }
}

public struct Quantity: Codable, Hashable, Sendable {
    public var value: Double?
    public var unit: String?
    public var system: String?
    public var code: String?

    public init(value: Double? = nil, unit: String? = nil, system: String? = nil, code: String? = nil) {
        self.value = value
        self.unit = unit
        self.system = system
        self.code = code
    }
}

public struct Period: Codable, Hashable, Sendable {
    public var start: String?
    public var end: String?

    public init(start: String? = nil, end: String? = nil) {
        self.start = start
        self.end = end
    }
}

/// FHIR extension with the small set of value[x] types this project uses.
public struct FHIRExtension: Codable, Hashable, Sendable {
    public var url: String
    public var valueBoolean: Bool?
    public var valueCode: String?
    public var valueString: String?
    public var valueDecimal: Double?
    public var valueInteger: Int?
    public var valueReference: Reference?

    public init(
        url: String,
        valueBoolean: Bool? = nil,
        valueCode: String? = nil,
        valueString: String? = nil,
        valueDecimal: Double? = nil,
        valueInteger: Int? = nil,
        valueReference: Reference? = nil
    ) {
        self.url = url
        self.valueBoolean = valueBoolean
        self.valueCode = valueCode
        self.valueString = valueString
        self.valueDecimal = valueDecimal
        self.valueInteger = valueInteger
        self.valueReference = valueReference
    }
}

public struct Meta: Codable, Hashable, Sendable {
    public var versionId: String?
    public var lastUpdated: String?
    public var tag: [Coding]?

    public init(versionId: String? = nil, lastUpdated: String? = nil, tag: [Coding]? = nil) {
        self.versionId = versionId
        self.lastUpdated = lastUpdated
        self.tag = tag
    }
}

public struct HumanName: Codable, Hashable, Sendable {
    public var given: [String]?
    public var family: String?
    public var text: String?

    public init(given: [String]? = nil, family: String? = nil, text: String? = nil) {
        self.given = given
        self.family = family
        self.text = text
    }
}

// MARK: - Resource protocol

/// Common surface every resource model shares; `resourceType` is the wire
/// discriminator and must be encoded on every write.
public protocol FHIRResource: Codable, Sendable {
    static var resourceType: String { get }
    var id: String? { get set }
    var meta: Meta? { get set }
}

// MARK: - Patient

public struct Patient: FHIRResource, Hashable {
    public static let resourceType = "Patient"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var name: [HumanName]?
    public var birthDate: String?

    public init(id: String? = nil, identifier: [Identifier]? = nil, name: [HumanName]? = nil) {
        self.id = id
        self.identifier = identifier
        self.name = name
    }

    public var displayName: String {
        if let n = name?.first {
            if let text = n.text, !text.isEmpty { return text }
            let parts = (n.given ?? []) + [n.family].compactMap { $0 }
            if !parts.isEmpty { return parts.joined(separator: " ") }
        }
        return "Owner"
    }
}

// MARK: - Medication + MedicationRequest

public struct Medication: FHIRResource, Hashable {
    public static let resourceType = "Medication"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var code: CodeableConcept?

    public init(id: String? = nil, code: CodeableConcept? = nil) {
        self.id = id
        self.code = code
    }
}

public struct TimingRepeat: Codable, Hashable, Sendable {
    /// FHIR `time` values always carry seconds ("09:00:00", never "09:00").
    public var timeOfDay: [String]?
    public var frequency: Int?
    public var period: Double?
    public var periodUnit: String?

    public init(timeOfDay: [String]? = nil) {
        self.timeOfDay = timeOfDay
    }
}

public struct Timing: Codable, Hashable, Sendable {
    public var repeatValue: TimingRepeat?

    enum CodingKeys: String, CodingKey {
        case repeatValue = "repeat"
    }

    public init(repeatValue: TimingRepeat? = nil) {
        self.repeatValue = repeatValue
    }
}

public struct Dosage: Codable, Hashable, Sendable {
    public var text: String?
    public var timing: Timing?

    public init(text: String? = nil, timing: Timing? = nil) {
        self.text = text
        self.timing = timing
    }
}

public struct MedicationRequest: FHIRResource, Hashable {
    public static let resourceType = "MedicationRequest"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var status: String?
    public var intent: String?
    public var subject: Reference?
    public var medicationReference: Reference?
    public var dosageInstruction: [Dosage]?
    public var authoredOn: String?
    public var extensions: [FHIRExtension]?

    enum CodingKeys: String, CodingKey {
        case resourceType, id, meta, identifier, status, intent, subject
        case medicationReference, dosageInstruction, authoredOn
        case extensions = "extension"
    }

    public init(
        id: String? = nil,
        identifier: [Identifier]? = nil,
        status: String? = nil,
        intent: String? = nil,
        subject: Reference? = nil,
        medicationReference: Reference? = nil,
        dosageInstruction: [Dosage]? = nil,
        authoredOn: String? = nil,
        extensions: [FHIRExtension]? = nil
    ) {
        self.id = id
        self.identifier = identifier
        self.status = status
        self.intent = intent
        self.subject = subject
        self.medicationReference = medicationReference
        self.dosageInstruction = dosageInstruction
        self.authoredOn = authoredOn
        self.extensions = extensions
    }
}

// MARK: - MedicationAdministration

public struct MedicationAdministration: FHIRResource, Hashable {
    public static let resourceType = "MedicationAdministration"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var status: String?
    public var statusReason: [CodeableConcept]?
    public var subject: Reference?
    public var medicationReference: Reference?
    public var request: Reference?
    public var effectiveDateTime: String?
    public var device: [Reference]?

    public init(
        id: String? = nil,
        identifier: [Identifier]? = nil,
        status: String? = nil,
        statusReason: [CodeableConcept]? = nil,
        subject: Reference? = nil,
        medicationReference: Reference? = nil,
        request: Reference? = nil,
        effectiveDateTime: String? = nil,
        device: [Reference]? = nil
    ) {
        self.id = id
        self.identifier = identifier
        self.status = status
        self.statusReason = statusReason
        self.subject = subject
        self.medicationReference = medicationReference
        self.request = request
        self.effectiveDateTime = effectiveDateTime
        self.device = device
    }
}

// MARK: - FHIRObservation

public struct ObservationComponent: Codable, Hashable, Sendable {
    public var code: CodeableConcept?
    public var valueQuantity: Quantity?

    public init(code: CodeableConcept? = nil, valueQuantity: Quantity? = nil) {
        self.code = code
        self.valueQuantity = valueQuantity
    }
}

/// Observation.referenceRange — source-provided bounds only. The app
/// displays these verbatim and never invents its own thresholds (SR-3).
public struct ObservationReferenceRange: Codable, Hashable, Sendable {
    public var low: Quantity?
    public var high: Quantity?
    public var text: String?

    public init(low: Quantity? = nil, high: Quantity? = nil, text: String? = nil) {
        self.low = low
        self.high = high
        self.text = text
    }
}

public struct FHIRObservation: FHIRResource, Hashable {
    public static let resourceType = "Observation"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var status: String?
    public var category: [CodeableConcept]?
    public var code: CodeableConcept?
    public var subject: Reference?
    public var effectiveDateTime: String?
    public var effectivePeriod: Period?
    public var valueQuantity: Quantity?
    public var valueInteger: Int?
    public var valueString: String?
    public var component: [ObservationComponent]?
    public var derivedFrom: [Reference]?
    public var focus: [Reference]?
    /// Lab display fields (read-only): the source's reference range and
    /// interpretation flags (H/L/A…), rendered as-is, never computed here.
    public var referenceRange: [ObservationReferenceRange]?
    public var interpretation: [CodeableConcept]?

    public init(
        id: String? = nil,
        identifier: [Identifier]? = nil,
        status: String? = nil,
        category: [CodeableConcept]? = nil,
        code: CodeableConcept? = nil,
        subject: Reference? = nil,
        effectiveDateTime: String? = nil,
        valueQuantity: Quantity? = nil,
        valueInteger: Int? = nil,
        valueString: String? = nil,
        component: [ObservationComponent]? = nil,
        derivedFrom: [Reference]? = nil,
        focus: [Reference]? = nil
    ) {
        self.id = id
        self.identifier = identifier
        self.status = status
        self.category = category
        self.code = code
        self.subject = subject
        self.effectiveDateTime = effectiveDateTime
        self.valueQuantity = valueQuantity
        self.valueInteger = valueInteger
        self.valueString = valueString
        self.component = component
        self.derivedFrom = derivedFrom
        self.focus = focus
    }
}

// MARK: - Device

public struct DeviceName: Codable, Hashable, Sendable {
    public var name: String?
    public var type: String?

    public init(name: String? = nil, type: String? = nil) {
        self.name = name
        self.type = type
    }
}

public struct DeviceProperty: Codable, Hashable, Sendable {
    public var type: CodeableConcept?
    /// R4 Device.property.valueQuantity is an ARRAY (0..*), unlike most
    /// valueQuantity fields — the web app reads `valueQuantity?.[0]`.
    public var valueQuantity: [Quantity]?

    public init(type: CodeableConcept? = nil, valueQuantity: [Quantity]? = nil) {
        self.type = type
        self.valueQuantity = valueQuantity
    }
}

public struct Device: FHIRResource, Hashable {
    public static let resourceType = "Device"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var status: String?
    public var type: CodeableConcept?
    public var deviceName: [DeviceName]?
    public var property: [DeviceProperty]?
    public var extensions: [FHIRExtension]?
    public var parent: Reference?

    enum CodingKeys: String, CodingKey {
        case resourceType, id, meta, identifier, status, type, deviceName, property, parent
        case extensions = "extension"
    }

    public init(id: String? = nil, status: String? = nil, deviceName: [DeviceName]? = nil) {
        self.id = id
        self.status = status
        self.deviceName = deviceName
    }
}

// MARK: - Questionnaire + QuestionnaireResponse

public struct QuestionnaireItem: Codable, Hashable, Sendable {
    public var linkId: String?
    public var text: String?
    /// group | display | integer | decimal | string | text | boolean | choice | date
    public var type: String?
    public var required: Bool?
    public var answerOption: [QuestionnaireAnswerOption]?
    public var item: [QuestionnaireItem]?
    public var extensions: [FHIRExtension]?

    enum CodingKeys: String, CodingKey {
        case linkId, text, type, required, answerOption, item
        case extensions = "extension"
    }

    public init(linkId: String? = nil, text: String? = nil, type: String? = nil) {
        self.linkId = linkId
        self.text = text
        self.type = type
    }
}

public struct QuestionnaireAnswerOption: Codable, Hashable, Sendable {
    public var valueCoding: Coding?
    public var valueString: String?
    public var valueInteger: Int?

    public init(valueCoding: Coding? = nil, valueString: String? = nil, valueInteger: Int? = nil) {
        self.valueCoding = valueCoding
        self.valueString = valueString
        self.valueInteger = valueInteger
    }
}

public struct Questionnaire: FHIRResource, Hashable {
    public static let resourceType = "Questionnaire"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var url: String?
    public var version: String?
    public var title: String?
    public var status: String?
    public var item: [QuestionnaireItem]?
    public var extensions: [FHIRExtension]?

    enum CodingKeys: String, CodingKey {
        case resourceType, id, meta, url, version, title, status, item
        case extensions = "extension"
    }

    public init(id: String? = nil, url: String? = nil, title: String? = nil, status: String? = nil) {
        self.id = id
        self.url = url
        self.title = title
        self.status = status
    }
}

public struct QuestionnaireResponseAnswer: Codable, Hashable, Sendable {
    public var valueInteger: Int?
    public var valueDecimal: Double?
    public var valueString: String?
    public var valueBoolean: Bool?
    public var valueDate: String?
    public var valueCoding: Coding?

    public init(
        valueInteger: Int? = nil,
        valueDecimal: Double? = nil,
        valueString: String? = nil,
        valueBoolean: Bool? = nil,
        valueDate: String? = nil,
        valueCoding: Coding? = nil
    ) {
        self.valueInteger = valueInteger
        self.valueDecimal = valueDecimal
        self.valueString = valueString
        self.valueBoolean = valueBoolean
        self.valueDate = valueDate
        self.valueCoding = valueCoding
    }

    /// Human-readable answer value for read-back displays.
    public var display: String? {
        if let v = valueInteger { return String(v) }
        if let v = valueDecimal {
            return v == v.rounded() ? String(Int(v)) : String(v)
        }
        if let v = valueString { return v }
        if let v = valueBoolean { return v ? "yes" : "no" }
        if let v = valueDate { return v }
        if let v = valueCoding { return v.display ?? v.code }
        return nil
    }
}

public struct QuestionnaireResponseItem: Codable, Hashable, Sendable {
    public var linkId: String?
    public var text: String?
    public var answer: [QuestionnaireResponseAnswer]?
    public var item: [QuestionnaireResponseItem]?

    public init(
        linkId: String? = nil,
        text: String? = nil,
        answer: [QuestionnaireResponseAnswer]? = nil,
        item: [QuestionnaireResponseItem]? = nil
    ) {
        self.linkId = linkId
        self.text = text
        self.answer = answer
        self.item = item
    }
}

public struct QuestionnaireResponse: FHIRResource, Hashable {
    public static let resourceType = "QuestionnaireResponse"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    /// R4: QuestionnaireResponse.identifier is 0..1 — a SINGLE Identifier,
    /// not an array like most resources. The period-dedup logic depends on it.
    public var identifier: Identifier?
    public var questionnaire: String?
    public var status: String?
    public var subject: Reference?
    public var authored: String?
    public var item: [QuestionnaireResponseItem]?

    public init(
        id: String? = nil,
        identifier: Identifier? = nil,
        questionnaire: String? = nil,
        status: String? = nil,
        subject: Reference? = nil,
        authored: String? = nil,
        item: [QuestionnaireResponseItem]? = nil
    ) {
        self.id = id
        self.identifier = identifier
        self.questionnaire = questionnaire
        self.status = status
        self.subject = subject
        self.authored = authored
        self.item = item
    }
}

// MARK: - Task (named FHIRTask to avoid clashing with Swift Concurrency's Task)

public struct TaskInput: Codable, Hashable, Sendable {
    public var type: CodeableConcept?
    public var valueReference: Reference?
    public var valueDecimal: Double?
    public var valueString: String?

    public init(type: CodeableConcept? = nil, valueReference: Reference? = nil) {
        self.type = type
        self.valueReference = valueReference
    }
}

public struct FHIRTask: FHIRResource, Hashable {
    public static let resourceType = "Task"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var status: String?
    public var intent: String?
    public var code: CodeableConcept?
    public var description: String?
    public var forSubject: Reference?
    public var focus: Reference?
    public var executionPeriod: Period?
    public var authoredOn: String?
    public var lastModified: String?
    public var input: [TaskInput]?

    enum CodingKeys: String, CodingKey {
        case resourceType, id, meta, identifier, status, intent, code, description
        case focus, executionPeriod, authoredOn, lastModified, input
        case forSubject = "for"
    }

    public init(id: String? = nil, status: String? = nil, description: String? = nil) {
        self.id = id
        self.status = status
        self.description = description
    }
}

// MARK: - DocumentReference

public struct Attachment: Codable, Hashable, Sendable {
    public var contentType: String?
    public var url: String?
    public var title: String?

    public init(contentType: String? = nil, url: String? = nil, title: String? = nil) {
        self.contentType = contentType
        self.url = url
        self.title = title
    }
}

public struct DocumentReferenceContent: Codable, Hashable, Sendable {
    public var attachment: Attachment?

    public init(attachment: Attachment? = nil) {
        self.attachment = attachment
    }
}

public struct DocumentReference: FHIRResource, Hashable {
    public static let resourceType = "DocumentReference"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var status: String?
    public var type: CodeableConcept?
    public var description: String?
    public var date: String?
    public var content: [DocumentReferenceContent]?

    public init(id: String? = nil, description: String? = nil) {
        self.id = id
        self.description = description
    }
}

// MARK: - Condition / AllergyIntolerance / Immunization (profile display, read-only)

public struct Condition: FHIRResource, Hashable {
    public static let resourceType = "Condition"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var clinicalStatus: CodeableConcept?
    public var verificationStatus: CodeableConcept?
    public var code: CodeableConcept?
    public var subject: Reference?
    public var onsetDateTime: String?
    public var recordedDate: String?

    public init(id: String? = nil, code: CodeableConcept? = nil) {
        self.id = id
        self.code = code
    }
}

public struct AllergyReaction: Codable, Hashable, Sendable {
    public var manifestation: [CodeableConcept]?
    public var severity: String?

    public init(manifestation: [CodeableConcept]? = nil, severity: String? = nil) {
        self.manifestation = manifestation
        self.severity = severity
    }
}

public struct AllergyIntolerance: FHIRResource, Hashable {
    public static let resourceType = "AllergyIntolerance"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var clinicalStatus: CodeableConcept?
    public var verificationStatus: CodeableConcept?
    /// low | high | unable-to-assess (source-provided, displayed verbatim)
    public var criticality: String?
    public var code: CodeableConcept?
    public var patient: Reference?
    public var recordedDate: String?
    public var reaction: [AllergyReaction]?

    public init(id: String? = nil, code: CodeableConcept? = nil) {
        self.id = id
        self.code = code
    }
}

public struct Immunization: FHIRResource, Hashable {
    public static let resourceType = "Immunization"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var status: String?
    public var vaccineCode: CodeableConcept?
    public var patient: Reference?
    public var occurrenceDateTime: String?
    public var lotNumber: String?

    public init(id: String? = nil, vaccineCode: CodeableConcept? = nil) {
        self.id = id
        self.vaccineCode = vaccineCode
    }
}

// MARK: - MedicationStatement (ingestion-sourced meds, read-only)

public struct MedicationStatement: FHIRResource, Hashable {
    public static let resourceType = "MedicationStatement"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var status: String?
    public var medicationCodeableConcept: CodeableConcept?
    public var medicationReference: Reference?
    public var subject: Reference?
    public var effectiveDateTime: String?
    public var effectivePeriod: Period?
    public var dateAsserted: String?

    public init(id: String? = nil, medicationCodeableConcept: CodeableConcept? = nil) {
        self.id = id
        self.medicationCodeableConcept = medicationCodeableConcept
    }
}

// MARK: - DiagnosticReport (labs, read-only)

public struct DiagnosticReport: FHIRResource, Hashable {
    public static let resourceType = "DiagnosticReport"
    public var resourceType: String = Self.resourceType
    public var id: String?
    public var meta: Meta?
    public var identifier: [Identifier]?
    public var status: String?
    public var category: [CodeableConcept]?
    public var code: CodeableConcept?
    public var subject: Reference?
    public var effectiveDateTime: String?
    public var issued: String?
    /// Member lab Observations (fetched via `_include=DiagnosticReport:result`).
    public var result: [Reference]?
    public var conclusion: String?

    public init(id: String? = nil, code: CodeableConcept? = nil) {
        self.id = id
        self.code = code
    }
}

// MARK: - Bundle

public struct BundleLink: Codable, Sendable {
    public var relation: String?
    public var url: String?
}

public struct BundleRequest: Codable, Sendable {
    public var method: String?
    public var url: String?
    public var ifNoneExist: String?
    /// Version-aware update inside a transaction (weak ETag, e.g. `W/"3"`) —
    /// the dispenser-style read-modify-write guard from FHIR-MAPPING.md §5.
    public var ifMatch: String?

    public init(method: String? = nil, url: String? = nil, ifNoneExist: String? = nil, ifMatch: String? = nil) {
        self.method = method
        self.url = url
        self.ifNoneExist = ifNoneExist
        self.ifMatch = ifMatch
    }
}

public struct BundleResponse: Codable, Sendable {
    public var status: String?
    public var location: String?
}

/// Bundle entry keeping the resource as raw JSON so mixed search results
/// (`_include`) decode without a giant resource enum. Callers re-decode the
/// payload into the concrete type they expect via `resource(_:)`.
public struct BundleEntry: Codable, Sendable {
    public var fullUrl: String?
    public var resource: JSONValue?
    public var request: BundleRequest?
    public var response: BundleResponse?

    public init(resource: JSONValue? = nil, request: BundleRequest? = nil) {
        self.resource = resource
        self.request = request
    }

    /// The entry's resourceType discriminator (nil when there is no resource).
    public var resourceType: String? {
        if case .object(let obj) = resource, case .string(let t)? = obj["resourceType"] {
            return t
        }
        return nil
    }

    /// Decode the raw resource into a concrete model when the type matches.
    public func resource<T: FHIRResource>(_ type: T.Type) -> T? {
        guard resourceType == T.resourceType, let resource else { return nil }
        guard let data = try? JSONEncoder().encode(resource) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}

public struct FHIRBundle: Codable, Sendable {
    public var resourceType: String = "Bundle"
    public var type: String?
    public var total: Int?
    public var link: [BundleLink]?
    public var entry: [BundleEntry]?

    public init(type: String? = nil, entry: [BundleEntry]? = nil) {
        self.type = type
        self.entry = entry
    }

    /// All resources of one concrete type (skips _include mix-ins and OperationOutcomes).
    public func resources<T: FHIRResource>(_ type: T.Type) -> [T] {
        (entry ?? []).compactMap { $0.resource(T.self) }
    }

    public var nextLink: String? {
        link?.first(where: { $0.relation == "next" })?.url
    }
}

// MARK: - OperationOutcome (server errors)

public struct OperationOutcomeIssue: Codable, Sendable {
    public var severity: String?
    public var code: String?
    public var diagnostics: String?
    public var details: CodeableConcept?
}

public struct OperationOutcome: Codable, Sendable {
    public var resourceType: String?
    public var issue: [OperationOutcomeIssue]?

    public var message: String? {
        issue?.compactMap { $0.details?.text ?? $0.diagnostics }.first
    }
}

// MARK: - JSONValue (schemaless FHIR payloads)

/// Generic JSON tree — used for Bundle entries and ingestion-proposal
/// candidate resources whose type is only known at runtime.
public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let b): try container.encode(b)
        case .number(let n):
            // Integral doubles encode as integers so FHIR fields like
            // valueInteger survive a decode/encode round trip.
            if n == n.rounded() && n.magnitude < 1e15 {
                try container.encode(Int64(n))
            } else {
                try container.encode(n)
            }
        case .string(let s): try container.encode(s)
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let obj) = self { return obj[key] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let n) = self { return n }
        return nil
    }
}
