import Foundation

/// Pure dose/adherence core — a line-for-line port of the medical-safety
/// logic in `frontend/src/fhir.ts` (see its header for the invariants).
/// The iOS app, the web app, the Pi dispenser and the reminders bot must all
/// derive the SAME dose-slot identity `{request-slug}-{date}T{HH:MM}` so any
/// writer's retry or correction converges on one MedicationAdministration.
///
/// Behavior rules ported verbatim (owner-approved, FHIR-MAPPING §3/§12):
/// - "No log ⇒ no resource": a dose the user never acted on has NO
///   MedicationAdministration; absence is never persisted as "missed".
/// - Days before a med's startDate yield no slots (a med added today must
///   not rewrite past days as unlogged).
/// - 'unlogged' (silence) and 'none-taken' (explicit skips/misses) are
///   different facts and are never conflated.
public enum DoseEngine {

    /// Display-urgency threshold only — crossing it never writes anything.
    /// Mirrors `OVERDUE_GRACE_MINUTES` in fhir.ts; changing it is
    /// adherence-display behavior → ask the owner.
    public static let overdueGraceMinutes = 90

    /// Proleptic Gregorian calendar in the device's CURRENT timezone. The web
    /// app (JS `Date`), the Pi dispenser and the bots all compute dose-slot
    /// dates on the Gregorian calendar, so DoseEngine must too — inheriting
    /// `Calendar.current` would, on a device set to a non-Gregorian calendar
    /// (Buddhist, Japanese, …), emit a different year in the slot identifier
    /// and break the cross-client identity contract. Timezone stays local
    /// (wall-clock dosing); a computed property re-reads it so a timezone
    /// change at runtime is picked up.
    public static var gregorian: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = .current
        c.locale = Locale(identifier: "en_US_POSIX")
        return c
    }

    // MARK: Calendar helpers

    /// Calendar date (YYYY-MM-DD) in the LOCAL timezone. Deliberately not a
    /// UTC slice — near midnight that lands on the wrong day and shifts dose
    /// slots, period identifiers and adherence stats by one day.
    public static func localDateString(_ date: Date, calendar: Calendar = DoseEngine.gregorian) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// A FHIR date/dateTime string → its LOCAL calendar date (YYYY-MM-DD).
    /// Port of `localCalendarDate` in fhir.ts: a date-only value
    /// ("2026-07-16") is returned verbatim — parsing it as an instant would
    /// treat it as UTC midnight and shift it a day in negative offsets. A
    /// value carrying a time is converted through the local timezone.
    public static func localCalendarDate(_ value: String, calendar: Calendar = DoseEngine.gregorian) -> String {
        guard value.count > 10, let parsed = RecordAPI.parseInstant(value) else {
            return String(value.prefix(10))
        }
        return localDateString(parsed, calendar: calendar)
    }

    /// Local Monday of the week containing `date` — the weekly period key.
    public static func mondayOf(_ date: Date, calendar: Calendar = DoseEngine.gregorian) -> String {
        // Mirrors JS `(getDay() + 6) % 7`: days to subtract to reach Monday.
        // Foundation weekday is 1=Sunday…7=Saturday; JS getDay is 0=Sunday.
        let weekday = calendar.component(.weekday, from: date) - 1 // 0=Sunday
        let daysBack = (weekday + 6) % 7
        let monday = calendar.date(byAdding: .day, value: -daysBack, to: date) ?? date
        return localDateString(monday, calendar: calendar)
    }

    /// Slot wall-clock time as a local Date ("YYYY-MM-DD" + "HH:MM:SS").
    public static func localDate(date: String, time: String, calendar: Calendar = DoseEngine.gregorian) -> Date {
        let d = date.split(separator: "-").compactMap { Int($0) }
        let t = time.split(separator: ":").compactMap { Int($0) }
        var components = DateComponents()
        components.year = d.count > 0 ? d[0] : nil
        components.month = d.count > 1 ? d[1] : nil
        components.day = d.count > 2 ? d[2] : nil
        components.hour = t.count > 0 ? t[0] : 0
        components.minute = t.count > 1 ? t[1] : 0
        components.second = t.count > 2 ? t[2] : 0
        return calendar.date(from: components) ?? Date.distantPast
    }

    // MARK: Slot identity

    /// The per-request half of the slot identity: the request's local
    /// business identifier (stable across export/reimport), else server id.
    public static func requestSlugBase(_ request: MedicationRequest) -> String {
        let local = request.identifier?.first(where: { $0.system == FHIR.medicationRequestIdentSystem })
        return local?.value ?? request.id ?? ""
    }

    /// THE dose-slot identity scheme: `{request-slug}-{date}T{HH:MM}`.
    /// Seconds are deliberately dropped — identity is minute-grained even
    /// though FHIR `time` values carry seconds.
    public static func slotIdentValue(_ med: MedInfo, date: String, time: String) -> String {
        "\(requestSlugBase(med.request))-\(date)T\(String(time.prefix(5)))"
    }

    // MARK: Slot expansion

    /// Expand schedules into concrete slots for one calendar date, sorted by
    /// time of day. Pure: identical inputs regenerate identical identValues.
    public static func slotsForDate(_ meds: [MedInfo], date: String, calendar: Calendar = DoseEngine.gregorian) -> [DoseSlot] {
        var slots: [DoseSlot] = []
        for med in meds {
            if !med.startDate.isEmpty, date < med.startDate {
                continue // med did not exist yet — no historical slots
            }
            for time in med.times {
                slots.append(
                    DoseSlot(
                        med: med,
                        date: date,
                        time: time,
                        identValue: slotIdentValue(med, date: date, time: time),
                        scheduled: localDate(date: date, time: time, calendar: calendar)
                    )
                )
            }
        }
        return slots.sorted { $0.time < $1.time }
    }

    /// The logged event for a slot, if any — strict identifier match only.
    /// `nil` means unlogged: a real, meaningful state, not an error.
    public static func adminForSlot(_ admins: [MedicationAdministration], _ slot: DoseSlot) -> MedicationAdministration? {
        admins.first { admin in
            admin.identifier?.contains {
                $0.system == FHIR.administrationIdentSystem && $0.value == slot.identValue
            } ?? false
        }
    }

    // MARK: Day summaries

    /// Roll up the trailing `days` calendar days (oldest first, ending
    /// `today`) by regenerating each day's slots and matching logged admins
    /// by identifier.
    public static func summarizeDays(
        meds: [MedInfo],
        admins: [MedicationAdministration],
        days: Int,
        today: Date = Date(),
        calendar: Calendar = DoseEngine.gregorian
    ) -> [DaySummary] {
        var out: [DaySummary] = []
        for i in stride(from: days - 1, through: 0, by: -1) {
            let d = calendar.date(byAdding: .day, value: -i, to: today) ?? today
            let date = localDateString(d, calendar: calendar)
            let slots = slotsForDate(meds, date: date, calendar: calendar)
            var taken = 0
            var notDone = 0
            for slot in slots {
                let admin = adminForSlot(admins, slot)
                if admin?.status == "completed" {
                    taken += 1
                } else if admin?.status == "not-done" {
                    notDone += 1
                }
            }
            var status = DayStatus.noDoses
            if !slots.isEmpty {
                if taken == slots.count {
                    status = .allTaken
                } else if taken > 0 {
                    status = .partial
                } else if notDone > 0 {
                    status = .noneTaken
                } else {
                    status = .unlogged
                }
            }
            out.append(DaySummary(date: date, scheduled: slots.count, taken: taken, notDone: notDone, status: status))
        }
        return out
    }

    // MARK: Adherence stats

    /// Stats computed from the SAME slot model as the day summaries so the
    /// percentage, per-med bars, calendar and streak always describe the
    /// same window. `streakDays` may be a longer window so the streak is not
    /// capped by the stats window.
    public static func adherenceStats(
        meds: [MedInfo],
        admins: [MedicationAdministration],
        daySummaries: [DaySummary],
        streakDays: [DaySummary]? = nil,
        calendar: Calendar = DoseEngine.gregorian
    ) -> AdherenceStats {
        func pctOf(taken: Int, notDone: Int) -> Int? {
            let logged = taken + notDone
            guard logged > 0 else { return nil }
            return Int((100.0 * Double(taken) / Double(logged)).rounded())
        }

        var perMedCounts: [String: (taken: Int, notDone: Int)] = [:]
        var taken = 0
        var notDone = 0
        for day in daySummaries {
            for med in meds {
                let key = med.request.id ?? ""
                var counts = perMedCounts[key] ?? (0, 0)
                for slot in slotsForDate([med], date: day.date, calendar: calendar) {
                    let admin = adminForSlot(admins, slot)
                    if admin?.status == "completed" {
                        counts.taken += 1
                        taken += 1
                    } else if admin?.status == "not-done" {
                        counts.notDone += 1
                        notDone += 1
                    }
                }
                perMedCounts[key] = counts
            }
        }

        let perMed = meds.map { med -> AdherenceStats.PerMed in
            let counts = perMedCounts[med.request.id ?? ""] ?? (0, 0)
            return AdherenceStats.PerMed(
                med: med,
                taken: counts.taken,
                notDone: counts.notDone,
                pct: pctOf(taken: counts.taken, notDone: counts.notDone)
            )
        }

        var streak = 0
        let chronological = Array((streakDays ?? daySummaries).reversed()) // today first
        for (i, day) in chronological.enumerated() {
            if i == 0 && day.status != .allTaken {
                if day.notDone > 0 { break } // an explicit skip/miss today ends the streak now
                continue // today merely not finished yet — judge from yesterday
            }
            if day.status == .allTaken {
                streak += 1
            } else if day.status != .noDoses {
                break
            }
        }

        return AdherenceStats(
            taken: taken,
            notDone: notDone,
            pct: pctOf(taken: taken, notDone: notDone),
            streak: streak,
            perMed: perMed
        )
    }
}

// MARK: - Value types

/// UI projection of one cartridge Device (FHIR-MAPPING §5). `low` is derived
/// and display-only — inventory NEVER gates whether a med may be taken.
/// Codable so the core snapshot can persist for offline launches.
public struct CartridgeInfo: Sendable, Hashable, Codable {
    public var device: Device
    public var name: String
    public var enabled: Bool
    /// Literal `Medication/{id}` reference from the device-assigned-medication extension.
    public var medicationRef: String?
    public var capacity: Double?
    public var remaining: Double?
    public var lowThreshold: Double?
    public var low: Bool

    public init(
        device: Device,
        name: String,
        enabled: Bool,
        medicationRef: String? = nil,
        capacity: Double? = nil,
        remaining: Double? = nil,
        lowThreshold: Double? = nil,
        low: Bool = false
    ) {
        self.device = device
        self.name = name
        self.enabled = enabled
        self.medicationRef = medicationRef
        self.capacity = capacity
        self.remaining = remaining
        self.lowThreshold = lowThreshold
        self.low = low
    }

    /// Flatten a cartridge Device (read-only projection; mirrors toCartridgeInfo).
    public init(device: Device) {
        func prop(_ code: String) -> Double? {
            device.property?
                .first { $0.type?.coding?.contains { $0.code == code } ?? false }?
                .valueQuantity?.first?.value
        }
        let capacity = prop("capacity")
        let remaining = prop("remaining-count")
        let lowThreshold = prop("low-stock-threshold")
        self.init(
            device: device,
            name: device.deviceName?.first?.name ?? "Cartridge",
            enabled: device.status == "active",
            medicationRef: device.extensions?.first(where: { $0.url == FHIR.extDeviceMedication })?.valueReference?.reference,
            capacity: capacity,
            remaining: remaining,
            lowThreshold: lowThreshold,
            low: remaining != nil && lowThreshold != nil && remaining! <= lowThreshold!
        )
    }
}

/// One active medication as the UI sees it (mirrors MedInfo in fhir.ts).
/// Codable so the core snapshot can persist for offline launches.
public struct MedInfo: Sendable, Hashable, Codable {
    public var request: MedicationRequest
    public var name: String
    public var instructions: String
    /// Owner-set life-critical extension: display prominence only, no dose logic.
    public var lifeCritical: Bool
    /// dosageInstruction.timing.repeat.timeOfDay — always HH:MM:SS.
    public var times: [String]
    public var cartridge: CartridgeInfo?
    /// First day this request is in effect — bounds historical slot generation.
    public var startDate: String

    public init(
        request: MedicationRequest,
        name: String,
        instructions: String,
        lifeCritical: Bool,
        times: [String],
        cartridge: CartridgeInfo? = nil,
        startDate: String
    ) {
        self.request = request
        self.name = name
        self.instructions = instructions
        self.lifeCritical = lifeCritical
        self.times = times
        self.cartridge = cartridge
        self.startDate = startDate
    }
}

/// One expected dose occurrence — computed from the schedule, NOT stored.
public struct DoseSlot: Sendable, Hashable {
    public var med: MedInfo
    public var date: String // YYYY-MM-DD
    public var time: String // HH:MM:SS
    public var identValue: String
    /// Slot time as a Date in the LOCAL timezone (wall-clock dosing).
    public var scheduled: Date

    public init(med: MedInfo, date: String, time: String, identValue: String, scheduled: Date) {
        self.med = med
        self.date = date
        self.time = time
        self.identValue = identValue
        self.scheduled = scheduled
    }
}

/// The three explicit user actions on a slot. "Did nothing" is deliberately
/// not an action — it leaves no resource behind.
public enum DoseAction: String, Sendable, CaseIterable {
    case taken
    case skipped
    case missed
}

/// Whole-day adherence classification. 'unlogged' (nothing recorded) is
/// deliberately distinct from 'noneTaken' (explicit skips/misses).
public enum DayStatus: String, Sendable {
    case allTaken = "all-taken"
    case partial
    case noneTaken = "none-taken"
    case unlogged
    case noDoses = "no-doses"
}

public struct DaySummary: Sendable, Hashable {
    public var date: String
    public var scheduled: Int
    public var taken: Int
    public var notDone: Int
    public var status: DayStatus

    public init(date: String, scheduled: Int, taken: Int, notDone: Int, status: DayStatus) {
        self.date = date
        self.scheduled = scheduled
        self.taken = taken
        self.notDone = notDone
        self.status = status
    }
}

public struct AdherenceStats: Sendable {
    public struct PerMed: Sendable {
        public var med: MedInfo
        public var taken: Int
        public var notDone: Int
        public var pct: Int?
    }

    public var taken: Int
    public var notDone: Int
    /// Of LOGGED doses (unlogged slots don't count against the percentage).
    public var pct: Int?
    /// Consecutive fully-taken days (ending today or yesterday).
    public var streak: Int
    public var perMed: [PerMed]
}

// MARK: - Check-in cadence engine (D / W / M periods)

public enum Cadence: String, Sendable, CaseIterable {
    case daily = "D"
    case weekly = "W"
    case monthly = "M"

    public var label: String {
        switch self {
        case .daily: return "Daily"
        case .weekly: return "Weekly"
        case .monthly: return "Monthly"
        }
    }
}

public enum CheckinEngine {
    /// Stable per-period identifier value: retries and resubmits within the
    /// same period update the same QuestionnaireResponse. Formats mirror
    /// FHIR-MAPPING §2: `{key}-{YYYY-MM-DD}` (D), `{key}-week-{monday}` (W),
    /// `{key}-month-{YYYY-MM}` (M) — all LOCAL calendar time.
    public static func periodIdentValue(
        questionnaireKey: String,
        cadence: Cadence,
        today: Date,
        calendar: Calendar = DoseEngine.gregorian
    ) -> String {
        switch cadence {
        case .daily:
            return "\(questionnaireKey)-\(DoseEngine.localDateString(today, calendar: calendar))"
        case .weekly:
            return "\(questionnaireKey)-week-\(DoseEngine.mondayOf(today, calendar: calendar))"
        case .monthly:
            return "\(questionnaireKey)-month-\(String(DoseEngine.localDateString(today, calendar: calendar).prefix(7)))"
        }
    }
}

/// One due-panel entry: a cadence-tagged Questionnaire plus this period's
/// identifier and existing response (present ⇒ already done, still editable).
public struct CheckinDef: Sendable, Hashable {
    public var questionnaire: Questionnaire
    public var cadence: Cadence
    public var periodIdent: String
    public var existing: QuestionnaireResponse?

    public init(questionnaire: Questionnaire, cadence: Cadence, periodIdent: String, existing: QuestionnaireResponse? = nil) {
        self.questionnaire = questionnaire
        self.cadence = cadence
        self.periodIdent = periodIdent
        self.existing = existing
    }

    /// "DUE" means: no response with this period identifier yet — dueness is
    /// derived, never stored.
    public var isDue: Bool {
        existing == nil
    }
}
