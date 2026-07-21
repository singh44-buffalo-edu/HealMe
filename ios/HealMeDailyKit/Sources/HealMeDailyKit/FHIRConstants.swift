import Foundation

/// Project-local FHIR systems — a 1:1 mirror of `frontend/src/fhir.ts` and
/// FHIR-MAPPING.md §1. These URLs are IDENTITY, not locations: never "fix"
/// them to a resolvable host, and never present local codes as LOINC/SNOMED.
/// The iOS app, the web frontend, the Pi dispenser and the bots must all
/// derive the exact same identifier values or idempotent writes stop
/// converging on the same logical resources.
public enum FHIR {
    public static let base = "https://healmedaily.local/fhir"
    public static let ident = "\(base)/identifier"
    public static let csObservation = "\(base)/CodeSystem/observation"
    public static let csAdherence = "\(base)/CodeSystem/adherence-reason"
    public static let csDevice = "\(base)/CodeSystem/device"
    public static let csTask = "\(base)/CodeSystem/task"
    public static let csIngest = "\(base)/CodeSystem/ingestion-task"
    public static let extLifeCritical = "\(base)/StructureDefinition/medicationrequest-life-critical"
    public static let extDeviceMedication = "\(base)/StructureDefinition/device-assigned-medication"
    public static let extCadence = "\(base)/StructureDefinition/questionnaire-cadence"

    /// Identifier systems (FHIR-MAPPING §7).
    public static let patientIdentSystem = "\(ident)/patient"
    /// The one-and-only owner Patient's seeded identifier value.
    public static let patientIdentValue = "healmedaily-user"
    public static let medicationRequestIdentSystem = "\(ident)/medication-request"
    public static let administrationIdentSystem = "\(ident)/medication-administration"
    public static let questionnaireResponseIdentSystem = "\(ident)/questionnaire-response"
    public static let quickObservationIdentSystem = "\(ident)/quick-observation"
    public static let ingestionIdentSystem = "\(ident)/ingestion"

    /// Standard terminologies — used only with VERIFIED codes (CLAUDE.md §3).
    public static let loinc = "http://loinc.org"
    public static let ucum = "http://unitsofmeasure.org"
    public static let observationCategory = "http://terminology.hl7.org/CodeSystem/observation-category"

    /// Meta tag marking deterministic Phase-4 imports.
    public static let tagsSystem = "\(base)/tags"
    /// Momentary feeling checks (FHIR-MAPPING §4): every entry carries
    /// `feeling-now`; values the user confirmed UNEDITED from an AI parse
    /// additionally carry `ai-parsed` (and must render ✦ AI-labeled).
    public static let tagFeelingNow = "feeling-now"
    public static let tagAiParsed = "ai-parsed"
}
