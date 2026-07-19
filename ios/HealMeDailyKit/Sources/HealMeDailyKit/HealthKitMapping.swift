import Foundation

/// HealthKit sample → FHIR Observation mapping — pure data in, pure FHIR out.
/// Deliberately does NOT import HealthKit: the Kit builds and tests on macOS;
/// the app target's HealthKitService converts HKSamples into these plain
/// values before calling in.
///
/// Mapping rules (owner-approved 2026-07-17, FHIR-MAPPING §7 `healthkit`):
/// - Identifier system `…/identifier/healthkit`. Per-sample kinds use the
///   HKSample UUID (lowercased) as the value; daily-aggregate kinds use
///   `{kind}-{YYYY-MM-DD}` — both make re-syncs converge via conditional
///   create instead of duplicating.
/// - Verified standard codes only (CLAUDE.md §3): every LOINC below is a
///   well-known code; sleep reuses the project-local `sleep-duration` code so
///   HealthKit nights land in the same series as manual entries.
/// - Aggregate kinds are only synced for FINISHED days (yesterday and
///   earlier) so their values are final and stable under re-sync.
/// - Every mapped Observation carries the `healthkit` source tag — measured
///   data, rendered as ink (never the AI class).
public enum HealthKitMapping {

    public static let identSystem = "\(FHIR.ident)/healthkit"
    /// meta.tag marking Apple Health as the source (same tag pattern as the
    /// Phase-4 importers' `imported` tag).
    public static let sourceTag = Coding(system: FHIR.tagsSystem, code: "healthkit", display: "Apple Health")

    /// The owner-approved sync scope.
    public enum Kind: String, CaseIterable, Sendable {
        // Daily aggregates (identifier {kind}-{date}, finished days only)
        case steps
        case restingHeartRate = "resting-heart-rate"
        case hrvSDNN = "hrv-sdnn"
        case sleepDuration = "sleep-duration"
        // Per-sample (identifier = HKSample UUID)
        case bodyMass = "body-mass"
        case bloodPressure = "blood-pressure"
        case oxygenSaturation = "oxygen-saturation"
        case bodyTemperature = "body-temperature"

        public var isDailyAggregate: Bool {
            switch self {
            case .steps, .restingHeartRate, .hrvSDNN, .sleepDuration: return true
            case .bodyMass, .bloodPressure, .oxygenSaturation, .bodyTemperature: return false
            }
        }
    }

    /// One plain, HealthKit-free sample value.
    public struct Sample: Sendable, Hashable {
        public var kind: Kind
        /// HKSample UUID (per-sample kinds) — ignored for daily aggregates.
        public var uuid: String
        /// Primary value in the canonical unit for the kind (see observation(for:)).
        public var value: Double
        /// Diastolic for blood pressure; unused otherwise.
        public var secondary: Double?
        public var start: Date
        public var end: Date

        public init(kind: Kind, uuid: String = "", value: Double, secondary: Double? = nil, start: Date, end: Date? = nil) {
            self.kind = kind
            self.uuid = uuid
            self.value = value
            self.secondary = secondary
            self.start = start
            self.end = end ?? start
        }
    }

    /// Stable identifier value for a sample (dedup key across re-syncs).
    public static func identifierValue(for sample: Sample) -> String {
        if sample.kind.isDailyAggregate {
            return "\(sample.kind.rawValue)-\(DoseEngine.localDateString(sample.start))"
        }
        return sample.uuid.lowercased()
    }

    /// Build the FHIR Observation for one sample. Subject is stamped by the
    /// save path (RecordAPI convention); identity and codes are stamped here.
    public static func observation(for sample: Sample) -> FHIRObservation {
        var obs = FHIRObservation(
            identifier: [Identifier(system: identSystem, value: identifierValue(for: sample))],
            status: "final"
        )
        obs.meta = Meta(tag: [sourceTag])

        let instant = RecordAPI.isoInstant(sample.end)
        switch sample.kind {
        case .steps:
            obs.category = [category("activity")]
            obs.code = code(loinc: "55423-8", display: "Number of steps")
            obs.valueQuantity = quantity(sample.value, unit: "steps", code: "{steps}")
            obs.effectivePeriod = Period(start: RecordAPI.isoInstant(sample.start), end: instant)
        case .restingHeartRate:
            // Day summary: effectivePeriod spans the day it DESCRIBES — an
            // effectiveDateTime at the period's end would land on the next
            // calendar day and shift every daily value by one on display.
            obs.category = [category("vital-signs")]
            obs.code = code(loinc: "40443-4", display: "Heart rate — resting")
            obs.valueQuantity = quantity(sample.value, unit: "beats/min", code: "/min")
            obs.effectivePeriod = Period(start: RecordAPI.isoInstant(sample.start), end: instant)
        case .hrvSDNN:
            obs.category = [category("vital-signs")]
            obs.code = code(loinc: "80404-7", display: "Heart rate variability (SDNN)")
            obs.valueQuantity = quantity(sample.value, unit: "ms", code: "ms")
            obs.effectivePeriod = Period(start: RecordAPI.isoInstant(sample.start), end: instant)
        case .sleepDuration:
            // Same local code as manual quick-add sleep so both land in one
            // series (FHIR-MAPPING §4); effectivePeriod = the night's span.
            obs.category = [category("survey")]
            obs.code = CodeableConcept(
                coding: [Coding(system: FHIR.csObservation, code: "sleep-duration", display: "Sleep duration")],
                text: "Sleep duration"
            )
            obs.valueQuantity = quantity(sample.value, unit: "h", code: "h")
            obs.effectivePeriod = Period(start: RecordAPI.isoInstant(sample.start), end: instant)
        case .bodyMass:
            obs.category = [category("vital-signs")]
            obs.code = code(loinc: "29463-7", display: "Body weight")
            obs.valueQuantity = quantity(sample.value, unit: "kg", code: "kg")
            obs.effectiveDateTime = instant
        case .bloodPressure:
            obs.category = [category("vital-signs")]
            obs.code = code(loinc: "85354-9", display: "Blood pressure panel")
            obs.component = [
                ObservationComponent(
                    code: code(loinc: "8480-6", display: "Systolic blood pressure"),
                    valueQuantity: quantity(sample.value, unit: "mmHg", code: "mm[Hg]")
                ),
                ObservationComponent(
                    code: code(loinc: "8462-4", display: "Diastolic blood pressure"),
                    valueQuantity: quantity(sample.secondary ?? 0, unit: "mmHg", code: "mm[Hg]")
                ),
            ]
            obs.effectiveDateTime = instant
        case .oxygenSaturation:
            obs.category = [category("vital-signs")]
            obs.code = code(loinc: "59408-5", display: "Oxygen saturation (pulse oximetry)")
            obs.valueQuantity = quantity(sample.value, unit: "%", code: "%")
            obs.effectiveDateTime = instant
        case .bodyTemperature:
            obs.category = [category("vital-signs")]
            obs.code = code(loinc: "8310-5", display: "Body temperature")
            obs.valueQuantity = quantity(sample.value, unit: "°C", code: "Cel")
            obs.effectiveDateTime = instant
        }
        return obs
    }

    // MARK: Small builders

    private static func category(_ codeValue: String) -> CodeableConcept {
        CodeableConcept(coding: [Coding(system: FHIR.observationCategory, code: codeValue)])
    }

    private static func code(loinc: String, display: String) -> CodeableConcept {
        CodeableConcept(coding: [Coding(system: FHIR.loinc, code: loinc, display: display)], text: display)
    }

    private static func quantity(_ value: Double, unit: String, code: String) -> Quantity {
        Quantity(value: value, unit: unit, system: FHIR.ucum, code: code)
    }
}
