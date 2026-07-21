import Foundation

/// FHIRObservation builders for manual quick-add capture — the exact FHIR shapes
/// from `frontend/src/pages/LogPage.tsx` (which itself enforces
/// FHIR-MAPPING §4 + the §2 vitals row):
///
/// - Verified standard codes only: LOINC for weight/BP/HR/temp/SpO2/glucose
///   with UCUM units; everything else uses the project-local CodeSystem
///   (sleep-duration, mood, energy, symptom, rx-question). Never invent
///   LOINC/SNOMED codes.
/// - BP is ONE FHIRObservation (panel 85354-9) with systolic/diastolic
///   components, not two separate results.
/// - Plausible-range validation only — deliberately NO clinical thresholds
///   or judgment until set with a clinician (spec SR-3 deferral).
/// - The caller (RecordAPI.saveQuickObservations) stamps subject +
///   quick-observation identifier; builders return everything else.
public enum QuickLog {

    public struct ValidationError: LocalizedError {
        public let message: String
        public var errorDescription: String? { message }

        public init(_ message: String) {
            self.message = message
        }
    }

    private static func surveyCategory() -> [CodeableConcept] {
        [CodeableConcept(coding: [Coding(system: FHIR.observationCategory, code: "survey")])]
    }

    private static func vitalsCategory() -> [CodeableConcept] {
        [CodeableConcept(coding: [Coding(system: FHIR.observationCategory, code: "vital-signs")])]
    }

    // MARK: Weight

    /// Weight in kg (owner decision: units kg) — verified LOINC 29463-7.
    /// Range gate 0–400 is plausibility only.
    public static func weight(kg: Double, when: Date) throws -> FHIRObservation {
        guard kg > 0, kg <= 400 else { throw ValidationError("Enter a weight in kg") }
        return FHIRObservation(
            status: "final",
            category: vitalsCategory(),
            code: CodeableConcept(coding: [Coding(system: FHIR.loinc, code: "29463-7", display: "Body weight")]),
            effectiveDateTime: RecordAPI.isoInstant(when),
            valueQuantity: Quantity(value: kg, unit: "kg", system: FHIR.ucum, code: "kg")
        )
    }

    // MARK: Sleep

    /// Hours slept — local code sleep-duration (no verified instrument yet).
    public static func sleep(hours: Double, when: Date) throws -> FHIRObservation {
        guard hours > 0, hours <= 24 else { throw ValidationError("Enter hours slept") }
        return FHIRObservation(
            status: "final",
            category: surveyCategory(),
            code: CodeableConcept(coding: [Coding(system: FHIR.csObservation, code: "sleep-duration", display: "Sleep duration")]),
            effectiveDateTime: RecordAPI.isoInstant(when),
            valueQuantity: Quantity(value: hours, unit: "h", system: FHIR.ucum, code: "h")
        )
    }

    // MARK: Mood & energy

    /// Mood + energy 1–10 — two independent Observations (local codes).
    public static func moodEnergy(mood: Int, energy: Int, when: Date) -> [FHIRObservation] {
        [("mood", mood), ("energy", energy)].map { code, value in
            FHIRObservation(
                status: "final",
                category: surveyCategory(),
                code: CodeableConcept(coding: [Coding(system: FHIR.csObservation, code: code, display: "\(code) (1-10)")]),
                effectiveDateTime: RecordAPI.isoInstant(when),
                valueInteger: value
            )
        }
    }

    // MARK: Momentary feeling ("How am I feeling right now?", FHIR-MAPPING §4)

    /// One momentary feeling check → one or two quick Observations using the
    /// SAME local codes/displays as the daily check-in (`mood` + optional
    /// `energy`), so momentary entries join the existing trend series with no
    /// new read model. Additions over `moodEnergy`:
    ///
    /// - Every entry carries `meta.tag` `feeling-now` ("Momentary check-in",
    ///   project tags system).
    /// - `moodAiParsed` / `energyAiParsed`: true ⇒ that entry ALSO carries
    ///   `meta.tag` `ai-parsed` ("AI-parsed from dictation") and must render
    ///   ✦ AI-labeled. THE RULE: the tag marks a value the user confirmed
    ///   UNEDITED from the AI parse — if the user manually edits a prefilled
    ///   value, the caller passes false and the tag is dropped, because the
    ///   saved number is then the user's own assertion, not the AI's.
    /// - Free text (typed or voice transcript) rides in `Observation.note`
    ///   on the mood entry. Voice audio itself is never stored.
    ///
    /// `when` is the moment of capture — "right now" is the point, so the
    /// UI deliberately offers no backdating here.
    public static func feelingNow(
        mood: Int,
        energy: Int? = nil,
        note: String? = nil,
        moodAiParsed: Bool = false,
        energyAiParsed: Bool = false,
        when: Date = Date()
    ) throws -> [FHIRObservation] {
        guard (1 ... 10).contains(mood) else { throw ValidationError("Mood must be 1–10") }
        if let energy, !(1 ... 10).contains(energy) { throw ValidationError("Energy must be 1–10") }

        var observations = [feelingObservation(code: "mood", value: mood, aiParsed: moodAiParsed, when: when)]
        if let energy {
            observations.append(feelingObservation(code: "energy", value: energy, aiParsed: energyAiParsed, when: when))
        }
        if let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
            observations[0].note = [Annotation(text: trimmed)]
        }
        return observations
    }

    /// Shared shape with `moodEnergy` (same code/display/category/value slot)
    /// plus the feeling-now / ai-parsed meta tags.
    private static func feelingObservation(code: String, value: Int, aiParsed: Bool, when: Date) -> FHIRObservation {
        var tags = [Coding(system: FHIR.tagsSystem, code: FHIR.tagFeelingNow, display: "Momentary check-in")]
        if aiParsed {
            tags.append(Coding(system: FHIR.tagsSystem, code: FHIR.tagAiParsed, display: "AI-parsed from dictation"))
        }
        var observation = FHIRObservation(
            status: "final",
            category: surveyCategory(),
            code: CodeableConcept(coding: [Coding(system: FHIR.csObservation, code: code, display: "\(code) (1-10)")]),
            effectiveDateTime: RecordAPI.isoInstant(when),
            valueInteger: value
        )
        observation.meta = Meta(tag: tags)
        return observation
    }

    // MARK: Symptom

    /// Free-text symptom/side effect — an FHIRObservation, not a Condition; any
    /// symptom↔med link is user-asserted elsewhere, never inferred here.
    public static func symptom(text: String, when: Date) throws -> FHIRObservation {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ValidationError("Describe the symptom") }
        return FHIRObservation(
            status: "final",
            category: surveyCategory(),
            code: CodeableConcept(
                coding: [Coding(system: FHIR.csObservation, code: "symptom", display: "Symptom")],
                text: "Symptom"
            ),
            effectiveDateTime: RecordAPI.isoInstant(when),
            valueString: trimmed
        )
    }

    // MARK: Question for the prescriber

    /// Local code rx-question — surfaces under "Questions for the prescriber"
    /// in the Health Review. Not backdatable: the ask-time is "now".
    public static func rxQuestion(text: String) throws -> FHIRObservation {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ValidationError("Write the question first") }
        return FHIRObservation(
            status: "final",
            category: surveyCategory(),
            code: CodeableConcept(
                coding: [Coding(system: FHIR.csObservation, code: "rx-question", display: "Question for prescriber")],
                text: "Question for prescriber"
            ),
            effectiveDateTime: RecordAPI.isoInstant(Date()),
            valueString: trimmed
        )
    }

    // MARK: Vitals

    public struct VitalsEntry: Sendable {
        public var systolic: Double?
        public var diastolic: Double?
        public var heartRate: Double?
        public var temperature: Double?
        public var spo2: Double?
        public var glucose: Double?

        public init(
            systolic: Double? = nil,
            diastolic: Double? = nil,
            heartRate: Double? = nil,
            temperature: Double? = nil,
            spo2: Double? = nil,
            glucose: Double? = nil
        ) {
            self.systolic = systolic
            self.diastolic = diastolic
            self.heartRate = heartRate
            self.temperature = temperature
            self.spo2 = spo2
            self.glucose = glucose
        }
    }

    /// Plausibility windows from the ingestion-module spec §12.12 — entry
    /// gates only, not clinical thresholds.
    public static let vitalsRanges: [(label: String, range: ClosedRange<Double>)] = [
        ("Systolic (mm Hg)", 70 ... 260),
        ("Diastolic (mm Hg)", 40 ... 160),
        ("Heart rate (/min)", 30 ... 220),
        ("Temperature (°C)", 34 ... 42),
        ("SpO2 (%)", 70 ... 100),
        ("Glucose (mg/dL)", 40 ... 500),
    ]

    /// Build vitals Observations for the fields that were filled in. BP must
    /// be a pair (the panel FHIRObservation needs both components).
    public static func vitals(_ entry: VitalsEntry, when: Date) throws -> [FHIRObservation] {
        let values = [entry.systolic, entry.diastolic, entry.heartRate, entry.temperature, entry.spo2, entry.glucose]
        for (value, spec) in zip(values, vitalsRanges) {
            if let value, !spec.range.contains(value) {
                throw ValidationError("\(spec.label): expected \(Int(spec.range.lowerBound))–\(Int(spec.range.upperBound))")
            }
        }
        if (entry.systolic == nil) != (entry.diastolic == nil) {
            throw ValidationError("Blood pressure needs both systolic and diastolic")
        }

        let effective = RecordAPI.isoInstant(when)
        var observations: [FHIRObservation] = []

        if let sys = entry.systolic, let dia = entry.diastolic {
            observations.append(FHIRObservation(
                status: "final",
                category: vitalsCategory(),
                code: CodeableConcept(coding: [Coding(system: FHIR.loinc, code: "85354-9", display: "Blood pressure panel")]),
                effectiveDateTime: effective,
                component: [
                    ObservationComponent(
                        code: CodeableConcept(coding: [Coding(system: FHIR.loinc, code: "8480-6", display: "Systolic blood pressure")]),
                        valueQuantity: Quantity(value: sys, unit: "mmHg", system: FHIR.ucum, code: "mm[Hg]")
                    ),
                    ObservationComponent(
                        code: CodeableConcept(coding: [Coding(system: FHIR.loinc, code: "8462-4", display: "Diastolic blood pressure")]),
                        valueQuantity: Quantity(value: dia, unit: "mmHg", system: FHIR.ucum, code: "mm[Hg]")
                    ),
                ]
            ))
        }

        let simple: [(value: Double?, loinc: String, display: String, unit: String, ucum: String)] = [
            (entry.heartRate, "8867-4", "Heart rate", "/min", "/min"),
            (entry.temperature, "8310-5", "Body temperature", "°C", "Cel"),
            (entry.spo2, "59408-5", "Oxygen saturation (pulse oximetry)", "%", "%"),
            (entry.glucose, "2339-0", "Glucose", "mg/dL", "mg/dL"),
        ]
        for spec in simple {
            if let value = spec.value {
                observations.append(FHIRObservation(
                    status: "final",
                    category: vitalsCategory(),
                    code: CodeableConcept(coding: [Coding(system: FHIR.loinc, code: spec.loinc, display: spec.display)]),
                    effectiveDateTime: effective,
                    valueQuantity: Quantity(value: value, unit: spec.unit, system: FHIR.ucum, code: spec.ucum)
                ))
            }
        }

        guard !observations.isEmpty else { throw ValidationError("Enter at least one vital") }
        return observations
    }
}
