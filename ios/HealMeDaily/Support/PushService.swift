import Foundation
import UIKit
import UserNotifications
import HealMeDailyKit

/// APNs remote-push client (opt-in, Settings toggle) — the server-driven
/// counterpart to the on-device ReminderScheduler.
///
/// The app is a public client: it holds NO APNs secret. It only obtains its
/// device token from the OS and registers it with the owner's own ai-service
/// (`/push/register`, bearer-forwarded); the privileged send happens
/// server-side. Notification payloads carry only a screen target — never a
/// medication name or any clinical content — so nothing sensitive lands on
/// the lock screen or in the payload.
///
/// A single shared instance is used so the UIApplicationDelegate (which the
/// OS instantiates separately from the SwiftUI view tree) and the AppModel
/// talk to the same object.
@MainActor
@Observable
final class PushService {
    static let shared = PushService()

    enum Status: Equatable {
        case off
        case requesting
        case denied // user declined the system prompt
        case on
    }

    private(set) var status: Status = .off
    private(set) var lastError: String?

    /// Weak so the service never keeps the model alive; set at bootstrap.
    @ObservationIgnored private weak var model: AppModel?
    /// Last device token we registered — kept so we can unregister it.
    @ObservationIgnored private var lastDeviceToken: String?

    private init() {}

    var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: "pushEnabled") }
        set { UserDefaults.standard.set(newValue, forKey: "pushEnabled") }
    }

    /// APNs environment for THIS build — the token is only valid against the
    /// matching APNs host (sandbox for development signing, production for
    /// TestFlight/App Store). Passed to the server so it targets the right one.
    private var environment: String {
        #if DEBUG
            return "sandbox"
        #else
            return "production"
        #endif
    }

    // MARK: Lifecycle

    /// Called once the session is up. Re-arms registration if the owner had
    /// push on (the OS may mint a fresh token across launches/reinstalls).
    func configure(model: AppModel) {
        self.model = model
        if enabled {
            status = .on
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func enable() async {
        status = .requesting
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            guard granted else {
                status = .denied
                enabled = false
                return
            }
            enabled = true
            status = .on
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            status = .off
            enabled = false
            lastError = error.localizedDescription
        }
    }

    /// Turn push off: drop the token server-side and stop remote registration.
    func disable() async {
        enabled = false
        status = .off
        await unregisterFromServer()
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    /// Sign-out: unregister the token (a different account may sign in next)
    /// but keep the `enabled` preference so re-sign-in re-registers.
    func handleSignOut() async {
        await unregisterFromServer()
    }

    // MARK: UIApplicationDelegate hand-offs

    func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        lastDeviceToken = token
        guard let model else { return }
        _Concurrency.Task {
            do {
                _ = try await model.ai.registerPush(deviceToken: token, environment: environment)
                self.lastError = nil
            } catch {
                // Registration is best-effort: a failure just means no server
                // pushes until the next attempt — never blocks the app.
                self.lastError = error.localizedDescription
            }
        }
    }

    func didFailToRegister(error: Error) {
        lastError = error.localizedDescription
    }

    /// Notification tapped — route to the screen named in the payload. The
    /// payload is non-clinical by contract (target/kind only); we read only
    /// the target and ignore everything else.
    func handleTap(userInfo: [AnyHashable: Any]) {
        guard let target = userInfo["target"] as? String else { return }
        model?.route(to: target)
    }

    private func unregisterFromServer() async {
        guard let token = lastDeviceToken, let model else { return }
        try? await model.ai.unregisterPush(deviceToken: token)
        lastDeviceToken = nil
    }
}

/// UIApplicationDelegate bridged into SwiftUI (UIApplicationDelegateAdaptor).
/// Owns nothing — it forwards remote-notification lifecycle to the shared
/// PushService, which does the app-model work on the main actor.
final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        _Concurrency.Task { @MainActor in PushService.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        _Concurrency.Task { @MainActor in PushService.shared.didFailToRegister(error: error) }
    }

    // Foreground: still show the banner (a reminder is worth surfacing even
    // with the app open).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // Tap → deep-link.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        _Concurrency.Task { @MainActor in
            PushService.shared.handleTap(userInfo: userInfo)
            completionHandler()
        }
    }
}
