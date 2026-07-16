import XCTest
@testable import HealMeDailyKit

/// Wire-shape guards: the JSON these models emit must match what the web
/// frontend writes (LogPage.tsx / CheckinPage.tsx) byte-for-byte in the
/// fields that carry identity or codes — a drifted key ("extensions" instead
/// of "extension", an array identifier on QuestionnaireResponse) would
/// corrupt idempotency or fail validation.
final class FHIRShapeTests: XCTestCase {

    private func json(_ resource: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(resource)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testExtensionEncodesAsFHIRKey() throws {
        var request = MedicationRequest(id: "r1", status: "active")
        request.extensions = [FHIRExtension(url: FHIR.extLifeCritical, valueBoolean: true)]
        let obj = try json(request)
        XCTAssertNotNil(obj["extension"], "must encode as 'extension', not 'extensions'")
        XCTAssertNil(obj["extensions"])
        XCTAssertEqual(obj["resourceType"] as? String, "MedicationRequest")
    }

    func testTimingRepeatEncodesAsFHIRKey() throws {
        let dosage = Dosage(text: "1 tablet", timing: Timing(repeatValue: TimingRepeat(timeOfDay: ["09:00:00"])))
        let data = try JSONEncoder().encode(dosage)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let timing = try XCTUnwrap(obj["timing"] as? [String: Any])
        XCTAssertNotNil(timing["repeat"], "must encode as 'repeat', not 'repeatValue'")
    }

    func testQuestionnaireResponseIdentifierIsSingleObject() throws {
        let response = QuestionnaireResponse(
            identifier: Identifier(system: FHIR.questionnaireResponseIdentSystem, value: "daily-check-in-2026-07-15"),
            questionnaire: "https://healmedaily.local/fhir/Questionnaire/daily-check-in",
            status: "completed"
        )
        let obj = try json(response)
        XCTAssertTrue(obj["identifier"] is [String: Any], "R4 QuestionnaireResponse.identifier is 0..1, not an array")
    }

    func testTaskForFieldEncodesAsFHIRKey() throws {
        var task = FHIRTask(id: "t1", status: "requested")
        task.forSubject = Reference(reference: "Patient/p1")
        let obj = try json(task)
        XCTAssertNotNil(obj["for"])
        XCTAssertNil(obj["forSubject"])
    }

    func testWeightObservationShape() throws {
        let obs = try QuickLog.weight(kg: 71.5, when: Date())
        let obj = try json(obs)
        let code = try XCTUnwrap(obj["code"] as? [String: Any])
        let coding = try XCTUnwrap((code["coding"] as? [[String: Any]])?.first)
        XCTAssertEqual(coding["system"] as? String, "http://loinc.org")
        XCTAssertEqual(coding["code"] as? String, "29463-7")
        let quantity = try XCTUnwrap(obj["valueQuantity"] as? [String: Any])
        XCTAssertEqual(quantity["code"] as? String, "kg")
        XCTAssertEqual(quantity["system"] as? String, "http://unitsofmeasure.org")
        let category = try XCTUnwrap((obj["category"] as? [[String: Any]])?.first)
        let categoryCoding = try XCTUnwrap((category["coding"] as? [[String: Any]])?.first)
        XCTAssertEqual(categoryCoding["code"] as? String, "vital-signs")
    }

    func testBloodPressureIsOnePanelObservation() throws {
        let observations = try QuickLog.vitals(.init(systolic: 120, diastolic: 80), when: Date())
        XCTAssertEqual(observations.count, 1)
        let obj = try json(observations[0])
        let code = try XCTUnwrap(obj["code"] as? [String: Any])
        let coding = try XCTUnwrap((code["coding"] as? [[String: Any]])?.first)
        XCTAssertEqual(coding["code"] as? String, "85354-9")
        let components = try XCTUnwrap(obj["component"] as? [[String: Any]])
        XCTAssertEqual(components.count, 2)
        let componentCodes = components.compactMap {
            (($0["code"] as? [String: Any])?["coding"] as? [[String: Any]])?.first?["code"] as? String
        }
        XCTAssertEqual(Set(componentCodes), ["8480-6", "8462-4"])
        let unit = (components.first?["valueQuantity"] as? [String: Any])?["code"] as? String
        XCTAssertEqual(unit, "mm[Hg]")
    }

    func testLoneSystolicRejected() {
        XCTAssertThrowsError(try QuickLog.vitals(.init(systolic: 120), when: Date()))
    }

    func testImplausibleVitalsRejected() {
        XCTAssertThrowsError(try QuickLog.vitals(.init(systolic: 500, diastolic: 80), when: Date()))
        XCTAssertThrowsError(try QuickLog.weight(kg: 0, when: Date()))
        XCTAssertThrowsError(try QuickLog.sleep(hours: 30, when: Date()))
    }

    func testMoodEnergyAreLocalCodedIntegers() throws {
        let observations = QuickLog.moodEnergy(mood: 7, energy: 4, when: Date())
        XCTAssertEqual(observations.count, 2)
        let obj = try json(observations[0])
        let code = try XCTUnwrap(obj["code"] as? [String: Any])
        let coding = try XCTUnwrap((code["coding"] as? [[String: Any]])?.first)
        XCTAssertEqual(coding["system"] as? String, "https://healmedaily.local/fhir/CodeSystem/observation")
        XCTAssertEqual(coding["code"] as? String, "mood")
        XCTAssertEqual(obj["valueInteger"] as? Int, 7)
    }

    func testBundleDecodesMixedIncludeEntries() throws {
        let payload = """
        {
          "resourceType": "Bundle",
          "type": "searchset",
          "entry": [
            {"resource": {"resourceType": "MedicationRequest", "id": "r1", "status": "active"}},
            {"resource": {"resourceType": "Medication", "id": "m1", "code": {"text": "Lisinopril 10mg"}}}
          ]
        }
        """
        let bundle = try JSONDecoder().decode(FHIRBundle.self, from: Data(payload.utf8))
        XCTAssertEqual(bundle.resources(MedicationRequest.self).count, 1)
        XCTAssertEqual(bundle.resources(Medication.self).first?.code?.text, "Lisinopril 10mg")
    }

    func testPKCEChallengeIsRFC7636() {
        // RFC 7636 appendix B reference vector.
        let challenge = MedplumClient.s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        let verifier = MedplumClient.randomVerifier()
        XCTAssertGreaterThanOrEqual(verifier.count, 43)
        XCTAssertFalse(verifier.contains("="))
        XCTAssertFalse(verifier.contains("+"))
        XCTAssertFalse(verifier.contains("/"))
    }
}
