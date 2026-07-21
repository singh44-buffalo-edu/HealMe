import XCTest
@testable import HealMeDailyKit

/// Payload-shape guards for momentary feeling checks (FHIR-MAPPING §4):
/// same local mood/energy codes as the daily check-in, `meta.tag`
/// feeling-now on every entry, `ai-parsed` ONLY on values the user confirmed
/// unedited from an AI parse, free text as an FHIR Annotation in
/// `Observation.note` — and all of it surviving the quick-observation
/// identifier stamping and the outbox round trip.
final class FeelingLogTests: XCTestCase {

    private func json(_ resource: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(resource)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func tagCodes(_ observation: FHIRObservation) -> [String] {
        (observation.meta?.tag ?? []).compactMap(\.code)
    }

    func testMoodOnlyEntryJoinsTheExistingSeries() throws {
        let observations = try QuickLog.feelingNow(mood: 7, note: "feeling pretty good")
        XCTAssertEqual(observations.count, 1)
        let obj = try json(observations[0])
        // Same code/display/category as QuickLog.moodEnergy — one trend series.
        let code = try XCTUnwrap(obj["code"] as? [String: Any])
        let coding = try XCTUnwrap((code["coding"] as? [[String: Any]])?.first)
        XCTAssertEqual(coding["system"] as? String, "https://healmedaily.local/fhir/CodeSystem/observation")
        XCTAssertEqual(coding["code"] as? String, "mood")
        XCTAssertEqual(coding["display"] as? String, "mood (1-10)")
        XCTAssertEqual(obj["valueInteger"] as? Int, 7)
        let category = try XCTUnwrap((obj["category"] as? [[String: Any]])?.first)
        let categoryCoding = try XCTUnwrap((category["coding"] as? [[String: Any]])?.first)
        XCTAssertEqual(categoryCoding["code"] as? String, "survey")
        XCTAssertNotNil(obj["effectiveDateTime"])
    }

    func testFeelingNowTagOnEveryEntry() throws {
        let observations = try QuickLog.feelingNow(mood: 4, energy: 6)
        XCTAssertEqual(observations.count, 2)
        for observation in observations {
            let tag = try XCTUnwrap(observation.meta?.tag?.first)
            XCTAssertEqual(tag.system, FHIR.tagsSystem)
            XCTAssertEqual(tag.code, "feeling-now")
            XCTAssertEqual(tag.display, "Momentary check-in")
        }
        XCTAssertEqual(observations[1].code?.code(in: FHIR.csObservation), "energy")
        XCTAssertEqual(observations[1].valueInteger, 6)
    }

    func testAiParsedTagIsPerValueNotPerAction() throws {
        // Mood confirmed unedited from the AI parse; energy manually adjusted
        // by the user — only mood keeps the ai-parsed tag (the edited value is
        // the user's assertion, not the AI's).
        let observations = try QuickLog.feelingNow(
            mood: 3, energy: 5, moodAiParsed: true, energyAiParsed: false
        )
        XCTAssertEqual(tagCodes(observations[0]), ["feeling-now", "ai-parsed"])
        XCTAssertEqual(tagCodes(observations[1]), ["feeling-now"])
        let aiTag = try XCTUnwrap(observations[0].meta?.tag?.last)
        XCTAssertEqual(aiTag.system, FHIR.tagsSystem)
        XCTAssertEqual(aiTag.display, "AI-parsed from dictation")
    }

    func testNoteEncodesAsFHIRAnnotationOnTheMoodEntry() throws {
        let observations = try QuickLog.feelingNow(
            mood: 6, energy: 4, note: "  bit of a headache after lunch  "
        )
        let obj = try json(observations[0])
        let note = try XCTUnwrap(obj["note"] as? [[String: Any]])
        XCTAssertEqual(note.count, 1)
        XCTAssertEqual(note.first?["text"] as? String, "bit of a headache after lunch")
        // The note rides on the mood entry only — never duplicated.
        XCTAssertNil(observations[1].note)
        // meta.tag reaches the wire as FHIR meta.
        let meta = try XCTUnwrap(obj["meta"] as? [String: Any])
        let tags = try XCTUnwrap(meta["tag"] as? [[String: Any]])
        XCTAssertEqual(tags.first?["code"] as? String, "feeling-now")
    }

    func testBlankNoteIsDroppedNotEncoded() throws {
        let observations = try QuickLog.feelingNow(mood: 5, note: "   ")
        XCTAssertNil(observations[0].note)
    }

    func testOutOfScaleValuesRejected() {
        XCTAssertThrowsError(try QuickLog.feelingNow(mood: 0))
        XCTAssertThrowsError(try QuickLog.feelingNow(mood: 11))
        XCTAssertThrowsError(try QuickLog.feelingNow(mood: 5, energy: 0))
        XCTAssertThrowsError(try QuickLog.feelingNow(mood: 5, energy: 11))
    }

    func testQuickIdentifierStampingPreservesTagsAndNote() throws {
        // The feeling entries take the EXISTING quick-observation path:
        // stampQuickIdentifiers adds the client-event-UUID identifier and must
        // leave meta.tag + note untouched.
        let stamped = RecordAPI.stampQuickIdentifiers(
            try QuickLog.feelingNow(mood: 8, energy: 2, note: "tired", moodAiParsed: true, energyAiParsed: true)
        )
        for observation in stamped {
            let ident = try XCTUnwrap(observation.identifier?.first)
            XCTAssertEqual(ident.system, FHIR.quickObservationIdentSystem)
            XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(ident.value)))
            XCTAssertEqual(tagCodes(observation), ["feeling-now", "ai-parsed"])
        }
        XCTAssertEqual(stamped[0].note?.first?.text, "tired")
    }

    func testFeelingEntriesSurviveTheOutboxRoundTrip() throws {
        // Offline queueing serializes the stamped payload; tags and note must
        // come back byte-identical so a drained replay writes the same entry.
        let payload = ObservationsPayload(
            observations: RecordAPI.stampQuickIdentifiers(
                try QuickLog.feelingNow(mood: 2, note: "rough morning", moodAiParsed: true)
            )
        )
        let data = try JSONEncoder().encode(OutboxEntry(kind: .observations(payload)))
        let decoded = try JSONDecoder().decode(OutboxEntry.self, from: data)
        guard case .observations(let restored) = decoded.kind else {
            return XCTFail("kind must survive the round trip")
        }
        XCTAssertEqual(restored, payload)
        XCTAssertEqual(restored.observations[0].note?.first?.text, "rough morning")
        XCTAssertEqual(tagCodes(restored.observations[0]), ["feeling-now", "ai-parsed"])
    }
}
