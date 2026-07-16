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
                    content.title = "HealMeDaily"
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
}
