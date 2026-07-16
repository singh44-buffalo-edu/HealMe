import XCTest
@testable import HealMeDailyKit

/// Port of `frontend/src/fhir.test.ts` — the dose/adherence core is
/// medical-safety logic, and the iOS engine must agree with the web engine
/// on every vector (identical slot identities, day classifications and
/// streak semantics) or the two apps would disagree about the same record.
final class DoseEngineTests: XCTestCase {

    private func med(_ id: String, _ slug: String, _ times: [String], startDate: String = "2020-01-01") -> MedInfo {
        MedInfo(
            request: MedicationRequest(
                id: id,
                identifier: [Identifier(system: FHIR.medicationRequestIdentSystem, value: slug)],
                status: "active",
                intent: "order",
                subject: Reference(reference: "Patient/p1")
            ),
            name: slug,
            instructions: "",
            lifeCritical: false,
            times: times,
            startDate: startDate
        )
    }

    private func admin(
        _ slug: String,
        _ date: String,
        _ time: String,
        _ status: String,
        reason: String? = nil
    ) -> MedicationAdministration {
        var administration = MedicationAdministration(
            identifier: [Identifier(system: FHIR.administrationIdentSystem, value: "\(slug)-\(date)T\(time)")],
            status: status,
            subject: Reference(reference: "Patient/p1"),
            effectiveDateTime: "\(date)T\(time):00Z"
        )
        if let reason {
            administration.statusReason = [CodeableConcept(coding: [Coding(system: FHIR.csAdherence, code: reason)])]
        }
        return administration
    }

    /// 2026-07-13 12:00 local — same anchor as the web tests.
    private var today: Date {
        var components = DateComponents()
        components.year = 2026
        components.month = 7
        components.day = 13
        components.hour = 12
        return Calendar.current.date(from: components)!
    }

    private func day(_ offset: Int) -> String {
        let d = Calendar.current.date(byAdding: .day, value: offset, to: today)!
        return DoseEngine.localDateString(d)
    }

    // MARK: slot identity

    func testStableIdentifierFromSlugDateAndMinutes() {
        let m = med("r1", "med-a", ["09:00:00"])
        XCTAssertEqual(DoseEngine.slotIdentValue(m, date: "2026-07-10", time: "09:00:00"), "med-a-2026-07-10T09:00")
    }

    func testMatchesAdminBySlotIdentifierNotTimeProximity() {
        let m = med("r1", "med-a", ["09:00:00"])
        let slots = DoseEngine.slotsForDate([m], date: "2026-07-10")
        let logged = admin("med-a", "2026-07-10", "09:00", "completed")
        let other = admin("med-a", "2026-07-11", "09:00", "completed")
        XCTAssertTrue(DoseEngine.adminForSlot([other, logged], slots[0])?.effectiveDateTime?.contains("2026-07-10") ?? false)
        XCTAssertNil(DoseEngine.adminForSlot([other], slots[0]))
    }

    // MARK: slotsForDate

    func testOneSlotPerTimeOfDaySortedByTime() {
        let m = med("r1", "med-b", ["21:00:00", "09:00:00"])
        let slots = DoseEngine.slotsForDate([m], date: "2026-07-10")
        XCTAssertEqual(slots.map(\.time), ["09:00:00", "21:00:00"])
    }

    func testNoSlotsBeforeMedicationStartDate() {
        let m = med("r1", "med-new", ["09:00:00"], startDate: "2026-07-10")
        XCTAssertEqual(DoseEngine.slotsForDate([m], date: "2026-07-09").count, 0)
        XCTAssertEqual(DoseEngine.slotsForDate([m], date: "2026-07-10").count, 1)
    }

    // MARK: summarizeDays

    func testClassifiesDayStatuses() {
        let m = med("r1", "med-a", ["09:00:00"])
        let admins = [
            admin("med-a", day(-3), "09:00", "completed"),
            admin("med-a", day(-2), "09:00", "not-done", reason: "user-skipped"),
            // day(-1): unlogged
        ]
        let days = DoseEngine.summarizeDays(meds: [m], admins: admins, days: 4, today: today)
        XCTAssertEqual(days.map(\.status), [.allTaken, .noneTaken, .unlogged, .unlogged])
    }

    func testDaysWithNoScheduledMedsAreNoDoses() {
        let days = DoseEngine.summarizeDays(meds: [], admins: [], days: 2, today: today)
        XCTAssertEqual(days.map(\.status), [.noDoses, .noDoses])
    }

    func testMedAddedTodayDoesNotRewriteHistory() {
        let newMed = med("r2", "med-new", ["09:00:00"], startDate: day(0))
        let days = DoseEngine.summarizeDays(meds: [newMed], admins: [], days: 3, today: today)
        XCTAssertEqual(days.map(\.status), [.noDoses, .noDoses, .unlogged])
    }

    // MARK: cadence periods

    func testMondayOfContainingWeek() {
        func date(_ y: Int, _ m: Int, _ d: Int) -> Date {
            var c = DateComponents()
            c.year = y
            c.month = m
            c.day = d
            c.hour = 12
            return Calendar.current.date(from: c)!
        }
        XCTAssertEqual(DoseEngine.mondayOf(date(2026, 7, 13)), "2026-07-13") // a Monday
        XCTAssertEqual(DoseEngine.mondayOf(date(2026, 7, 15)), "2026-07-13") // Wednesday
        XCTAssertEqual(DoseEngine.mondayOf(date(2026, 7, 19)), "2026-07-13") // Sunday → previous Monday
    }

    func testDistinctStablePeriodIdentifiersPerCadence() {
        var c = DateComponents()
        c.year = 2026
        c.month = 7
        c.day = 15
        c.hour = 12
        let d = Calendar.current.date(from: c)!
        XCTAssertEqual(
            CheckinEngine.periodIdentValue(questionnaireKey: "daily-check-in", cadence: .daily, today: d),
            "daily-check-in-2026-07-15"
        )
        XCTAssertEqual(
            CheckinEngine.periodIdentValue(questionnaireKey: "weekly-reflection", cadence: .weekly, today: d),
            "weekly-reflection-week-2026-07-13"
        )
        XCTAssertEqual(
            CheckinEngine.periodIdentValue(questionnaireKey: "weekly-reflection", cadence: .monthly, today: d),
            "weekly-reflection-month-2026-07"
        )
    }

    // MARK: adherenceStats

    func testCountsOnlySlotMatchedAdminsInsideWindow() {
        let m = med("r1", "med-a", ["09:00:00"])
        let admins = [
            admin("med-a", day(-1), "09:00", "completed"),
            admin("med-a", day(-2), "09:00", "not-done", reason: "user-skipped"),
            admin("med-a", day(-40), "09:00", "completed"), // outside window — ignored
        ]
        let days = DoseEngine.summarizeDays(meds: [m], admins: admins, days: 7, today: today)
        let stats = DoseEngine.adherenceStats(meds: [m], admins: admins, daySummaries: days)
        XCTAssertEqual(stats.taken, 1)
        XCTAssertEqual(stats.notDone, 1)
        XCTAssertEqual(stats.pct, 50)
        XCTAssertEqual(stats.perMed[0].taken, 1)
    }

    func testStreakCountsConsecutiveFullyTakenDaysAndSkipsUnfinishedToday() {
        let m = med("r1", "med-a", ["09:00:00"])
        let admins = [
            admin("med-a", day(-1), "09:00", "completed"),
            admin("med-a", day(-2), "09:00", "completed"),
            admin("med-a", day(-3), "09:00", "not-done", reason: "user-skipped"),
        ]
        let days = DoseEngine.summarizeDays(meds: [m], admins: admins, days: 7, today: today)
        XCTAssertEqual(DoseEngine.adherenceStats(meds: [m], admins: admins, daySummaries: days).streak, 2)
    }

    func testExplicitSkipTodayEndsStreakImmediately() {
        let m = med("r1", "med-a", ["09:00:00"])
        let admins = [
            admin("med-a", day(0), "09:00", "not-done", reason: "user-skipped"),
            admin("med-a", day(-1), "09:00", "completed"),
        ]
        let days = DoseEngine.summarizeDays(meds: [m], admins: admins, days: 7, today: today)
        XCTAssertEqual(DoseEngine.adherenceStats(meds: [m], admins: admins, daySummaries: days).streak, 0)
    }

    func testStreakCanUseLongerWindowThanStats() {
        let m = med("r1", "med-a", ["09:00:00"])
        let admins = (1...40).map { admin("med-a", day(-$0), "09:00", "completed") }
        let statsDays = DoseEngine.summarizeDays(meds: [m], admins: admins, days: 30, today: today)
        let fullDays = DoseEngine.summarizeDays(meds: [m], admins: admins, days: 60, today: today)
        let stats = DoseEngine.adherenceStats(meds: [m], admins: admins, daySummaries: statsDays, streakDays: fullDays)
        XCTAssertEqual(stats.streak, 40)
    }
}
