import Foundation
import UserNotifications
import HealMeDailyKit

/// Local dose reminders, computed on-device from the MedicationRequest
/// schedule — nothing is sent anywhere. One repeating calendar notification
/// per (medication, time-of-day). Purely a nudge: tapping it opens the app;
/// it never logs anything by itself (no-log ⇒ no-resource stays intact).
enum ReminderScheduler {
    private static let idPrefix = "dose-reminder-"
    /// iOS caps pending notifications at 64 — leave headroom for others.
    private static let maxReminders = 60

    static func requestPermissionAndSchedule(meds: [MedInfo], showMedName: Bool) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            reschedule(meds: meds, showMedName: showMedName)
        }
    }

    static func reschedule(meds: [MedInfo], showMedName: Bool) {
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { pending in
            let stale = pending.map(\.identifier).filter { $0.hasPrefix(idPrefix) }
            center.removePendingNotificationRequests(withIdentifiers: stale)

            var count = 0
            for med in meds {
                for time in med.times {
                    guard count < maxReminders else { return }
                    let parts = time.split(separator: ":").compactMap { Int($0) }
                    guard parts.count >= 2 else { continue }
                    var components = DateComponents()
                    components.hour = parts[0]
                    components.minute = parts[1]

                    let content = UNMutableNotificationContent()
                    content.title = "HealMeNow"
                    // Privacy default: no med name on the lock screen unless
                    // the owner opted in.
                    content.body = showMedName
                        ? "Time for \(med.name)"
                        : "Medication due — open to log it"
                    content.sound = .default

                    let slug = DoseEngine.requestSlugBase(med.request)
                    let request = UNNotificationRequest(
                        identifier: "\(idPrefix)\(slug)-\(Fmt.hhmm(time))",
                        content: content,
                        trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
                    )
                    center.add(request)
                    count += 1
                }
            }
        }
    }

    static func cancelAll() {
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { pending in
            let ours = pending.map(\.identifier).filter { $0.hasPrefix(idPrefix) }
            center.removePendingNotificationRequests(withIdentifiers: ours)
        }
    }

    // MARK: - Momentary feeling check-ins (FHIR-MAPPING §4: client-local only)

    private static let feelingIdPrefix = "feeling-reminder-"
    /// Owner-facing cadence window: reminders are evenly spaced 09:00–21:00.
    private static let feelingWindowStartHour = 9
    private static let feelingWindowEndHour = 21

    static func requestPermissionAndScheduleFeelingCheckins(timesPerDay: Int) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            rescheduleFeelingCheckins(timesPerDay: timesPerDay)
        }
    }

    /// One repeating calendar notification per daily slot. The payload is a
    /// generic prompt plus a screen target — NO health data (nothing about
    /// mood, meds or the record ever rides a notification).
    static func rescheduleFeelingCheckins(timesPerDay: Int) {
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { pending in
            let stale = pending.map(\.identifier).filter { $0.hasPrefix(feelingIdPrefix) }
            center.removePendingNotificationRequests(withIdentifiers: stale)
            guard timesPerDay > 0 else { return }

            for slot in feelingTimes(timesPerDay) {
                var components = DateComponents()
                components.hour = slot.hour
                components.minute = slot.minute

                let content = UNMutableNotificationContent()
                content.title = "HealMeNow"
                content.body = "How are you feeling right now?"
                content.sound = .default
                // Tap → the feeling capture sheet (PushAppDelegate.handleTap
                // reads only this target — same contract as server pushes).
                content.userInfo = ["target": "feeling"]

                let request = UNNotificationRequest(
                    identifier: String(format: "%@%02d%02d", feelingIdPrefix, slot.hour, slot.minute),
                    content: content,
                    trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
                )
                center.add(request)
            }
        }
    }

    static func cancelFeelingCheckins() {
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { pending in
            let ours = pending.map(\.identifier).filter { $0.hasPrefix(feelingIdPrefix) }
            center.removePendingNotificationRequests(withIdentifiers: ours)
        }
    }

    /// Evenly spaced slots across the 09:00–21:00 window: 2× → 09:00/21:00,
    /// 3× → 09:00/15:00/21:00, 4× → 09:00/13:00/17:00/21:00. A single
    /// reminder (not offered in the UI, but total anyway) sits mid-window.
    static func feelingTimes(_ timesPerDay: Int) -> [(hour: Int, minute: Int)] {
        guard timesPerDay > 0 else { return [] }
        let startMinutes = feelingWindowStartHour * 60
        let windowMinutes = (feelingWindowEndHour - feelingWindowStartHour) * 60
        guard timesPerDay > 1 else {
            let mid = startMinutes + windowMinutes / 2
            return [(mid / 60, mid % 60)]
        }
        return (0 ..< timesPerDay).map { index in
            let total = startMinutes + windowMinutes * index / (timesPerDay - 1)
            return (total / 60, total % 60)
        }
    }
}
