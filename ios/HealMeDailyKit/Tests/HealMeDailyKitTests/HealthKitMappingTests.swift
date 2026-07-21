import XCTest
@testable import HealMeDailyKit

/// HealthKit → FHIR mapping invariants: verified codes, canonical units, the
/// healthkit identifier convention (HK UUID vs {kind}-{date}), and the source
/// tag that keeps Apple Health data in the measured-ink class.
final class HealthKitMappingTests: XCTestCase {

    private let noon = DoseEngine.localDate(date: "2026-07-13", time: "12:00:00")

    func testDailyAggregateIdentifierIsKindPlusLocalDate() {
        let sample = HealthKitMapping.Sample(kind: .steps, value: 8500, start: noon)
        XCTAssertEqual(HealthKitMapping.identifierValue(for: sample), "steps-2026-07-13")
        let hrv = HealthKitMapping.Sample(kind: .hrvSDNN, value: 48, start: noon)
        XCTAssertEqual(HealthKitMapping.identifierValue(for: hrv), "hrv-sdnn-2026-07-13")
    }

    func testSleepIdentifierIsKeyedToWakeDateSoNapAndNightStayDistinct() {
        // Monday-afternoon nap: starts and ends Mon → keyed to Mon.
        let nap = HealthKitMapping.Sample(
            kind: .sleepDuration,
            value: 1.5,
            start: DoseEngine.localDate(date: "2026-07-13", time: "14:00:00"),
            end: DoseEngine.localDate(date: "2026-07-13", time: "15:30:00")
        )
        // The following night: Mon 23:00 → Tue 06:30. Start-keyed it would
        // collide with the nap and the two would overwrite each other on
        // every re-sync; end-keyed it belongs to Tue (its wake-up date).
        let night = HealthKitMapping.Sample(
            kind: .sleepDuration,
            value: 7.5,
            start: DoseEngine.localDate(date: "2026-07-13", time: "23:00:00"),
            end: DoseEngine.localDate(date: "2026-07-14", time: "06:30:00")
        )
        XCTAssertEqual(HealthKitMapping.identifierValue(for: nap), "sleep-duration-2026-07-13")
        XCTAssertEqual(HealthKitMapping.identifierValue(for: night), "sleep-duration-2026-07-14")
        XCTAssertNotEqual(
            HealthKitMapping.identifierValue(for: nap),
            HealthKitMapping.identifierValue(for: night)
        )
    }

    func testSleepIdentifierStableWhenNightStartMovesAcrossMidnight() {
        // Night first synced as Tue 00:30 → 06:30…
        let night = HealthKitMapping.Sample(
            kind: .sleepDuration,
            value: 6.0,
            start: DoseEngine.localDate(date: "2026-07-14", time: "00:30:00"),
            end: DoseEngine.localDate(date: "2026-07-14", time: "06:30:00")
        )
        // …then late-arriving watch data pulls its earliest sample back to
        // Mon 23:40. The end-keyed identifier must not move (start-keyed it
        // would re-key from Tue to Mon and duplicate the night).
        var extended = night
        extended.start = DoseEngine.localDate(date: "2026-07-13", time: "23:40:00")
        extended.value = 6.8
        XCTAssertEqual(HealthKitMapping.identifierValue(for: night), "sleep-duration-2026-07-14")
        XCTAssertEqual(
            HealthKitMapping.identifierValue(for: extended),
            HealthKitMapping.identifierValue(for: night)
        )
    }

    func testPerSampleIdentifierIsLowercasedUUID() {
        let sample = HealthKitMapping.Sample(kind: .bodyMass, uuid: "ABC-DEF", value: 71.2, start: noon)
        XCTAssertEqual(HealthKitMapping.identifierValue(for: sample), "abc-def")
    }

    func testStepsShape() throws {
        let obs = HealthKitMapping.observation(
            for: .init(kind: .steps, value: 8500, start: noon, end: noon.addingTimeInterval(3600))
        )
        XCTAssertEqual(obs.code?.code(in: FHIR.loinc), "55423-8")
        XCTAssertEqual(obs.valueQuantity?.code, "{steps}")
        XCTAssertNotNil(obs.effectivePeriod)
        XCTAssertEqual(obs.identifier?.first?.system, HealthKitMapping.identSystem)
        XCTAssertEqual(obs.meta?.tag?.first?.code, "healthkit")
        XCTAssertEqual(obs.category?.first?.code(in: FHIR.observationCategory), "activity")
    }

    func testSleepReusesLocalCodeSoSeriesMergeWithManualEntries() {
        let obs = HealthKitMapping.observation(
            for: .init(kind: .sleepDuration, value: 7.4, start: noon, end: noon.addingTimeInterval(8 * 3600))
        )
        XCTAssertEqual(obs.code?.code(in: FHIR.csObservation), "sleep-duration")
        XCTAssertEqual(obs.valueQuantity?.code, "h")
    }

    func testBloodPressureMatchesQuickLogPanelShape() {
        let obs = HealthKitMapping.observation(
            for: .init(kind: .bloodPressure, uuid: "u1", value: 121, secondary: 79, start: noon)
        )
        XCTAssertEqual(obs.code?.code(in: FHIR.loinc), "85354-9")
        let codes = obs.component?.compactMap { $0.code?.code(in: FHIR.loinc) }
        XCTAssertEqual(Set(codes ?? []), ["8480-6", "8462-4"])
        XCTAssertEqual(obs.component?.first?.valueQuantity?.code, "mm[Hg]")
    }

    func testVitalsUseVerifiedLoincAndUcum() {
        let cases: [(HealthKitMapping.Kind, String, String)] = [
            (.restingHeartRate, "40443-4", "/min"),
            (.hrvSDNN, "80404-7", "ms"),
            (.bodyMass, "29463-7", "kg"),
            (.oxygenSaturation, "59408-5", "%"),
            (.bodyTemperature, "8310-5", "Cel"),
        ]
        for (kind, loinc, ucum) in cases {
            let obs = HealthKitMapping.observation(for: .init(kind: kind, uuid: "u", value: 1, start: noon))
            XCTAssertEqual(obs.code?.code(in: FHIR.loinc), loinc, "\(kind)")
            XCTAssertEqual(obs.valueQuantity?.code, ucum, "\(kind)")
            XCTAssertEqual(obs.valueQuantity?.system, FHIR.ucum, "\(kind)")
        }
    }
}
