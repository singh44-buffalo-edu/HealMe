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
    /// In-memory only: it exists once `didRegister` has fired in THIS launch;
    /// across launches `persistedToken` is the fallback.
    @ObservationIgnored private var lastDeviceToken: String?

    private init() {}

    var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: "pushEnabled") }
        set { UserDefaults.standard.set(newValue, forKey: "pushEnabled") }
    }

    /// The token the server last accepted, persisted so a relaunch can still
    /// unregister it (sign-out / toggle-off can happen before this launch's
    /// APNs callback ever delivers a token). UserDefaults is fine here: an
    /// APNs device token is not a secret — it's an opaque per-app routing
    /// handle, useless without the server's APNs provider key. Cleared only
    /// after a successful /push/unregister.
    private var persistedToken: String? {
        get { UserDefaults.standard.string(forKey: "pushLastRegisteredToken") }
        set { UserDefaults.standard.set(newValue, forKey: "pushLastRegisteredToken") }
    }

    /// Set when an unregister could not be delivered (no token yet, offline,
    /// server error) so the server may still hold a token the owner disavowed.
    /// Settled on the next launch/enable BEFORE any re-register.
    private var unregisterOwed: Bool {
        get { UserDefaults.standard.bool(forKey: "pushUnregisterOwed") }
        set { UserDefaults.standard.set(newValue, forKey: "pushUnregisterOwed") }
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

    /// Called once the session is up. Settles any unregister still owed from
    /// a previous launch first, then re-arms registration if the owner had
    /// push on (the OS may mint a fresh token across launches/reinstalls) —
    /// but reconciles against the REAL OS authorization first, so a user who
    /// turned notifications off in iOS Settings sees the toggle reflect that
    /// instead of a false "on".
    func configure(model: AppModel) {
        self.model = model
        _Concurrency.Task {
            await self.settleOwedUnregister()
            guard self.enabled else { return }
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                self.status = .on
                UIApplication.shared.registerForRemoteNotifications()
            case .denied:
                self.status = .denied
            default: // .notDetermined — treat as off until the owner re-enables
                self.status = .off
            }
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
            // Settle any owed unregister BEFORE re-registering so a stale
            // token can't be dropped after the fresh one lands.
            await settleOwedUnregister()
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
        // A token callback can arrive AFTER the owner toggled push off (the OS
        // delivers it asynchronously). Registering it then would re-arm push
        // for a disabled device — drop it.
        guard enabled else { return }
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        lastDeviceToken = token
        guard let model else { return }
        _Concurrency.Task {
            do {
                _ = try await model.ai.registerPush(deviceToken: token, environment: environment)
                // The server now intentionally holds this token: persist it
                // so a future launch can still unregister it, and drop any
                // owed unregister — a successful registration supersedes it.
                self.persistedToken = token
                self.unregisterOwed = false
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
        // The in-memory token only exists once didRegister has fired in THIS
        // launch — after a relaunch (or before the async APNs callback lands)
        // fall back to the token persisted at the last successful register.
        let token = lastDeviceToken ?? persistedToken
        lastDeviceToken = nil
        await sendUnregister(of: token)
    }

    /// Retry an unregister we still owe the server (a previous one failed or
    /// had no token to send yet). Runs on launch/enable, before any
    /// re-register, so the server stops dispatching to a device whose owner
    /// disabled push or signed out.
    private func settleOwedUnregister() async {
        guard unregisterOwed else { return }
        await sendUnregister(of: persistedToken)
    }

    /// Best-effort /push/unregister. The persisted token and the owed flag
    /// are cleared only on success; any failure (or having no token to send)
    /// leaves the debt recorded so `settleOwedUnregister` retries it.
    private func sendUnregister(of token: String?) async {
        guard let token, let model else {
            unregisterOwed = true
            return
        }
        do {
            try await model.ai.unregisterPush(deviceToken: token)
            persistedToken = nil
            unregisterOwed = false
        } catch {
            unregisterOwed = true
            lastError = error.localizedDescription
        }
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
