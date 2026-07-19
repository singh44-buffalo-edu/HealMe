import SwiftUI

/// Shell contract (mirrors the web App.tsx): session restoring → loader ·
/// no session → sign-in · signed in → tab shell. A Face ID lock overlays
/// everything when the owner enabled it.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            switch model.authState {
            case .loading:
                T.canvas.ignoresSafeArea()
                ProgressView()
                    .tint(T.green)
            case .signedOut:
                LoginView()
            case .signedIn:
                MainTabView()
            }

            if model.requireBiometrics && !model.unlocked {
                LockView()
            }

            // Privacy shade: an opaque cover whenever the app is not active
            // (the app-switcher snapshot, Control Center pull-down, an
            // incoming call) so the health record never shows in the
            // multitasking preview. Distinct from the lock — it needs no
            // re-auth and clears the instant the app is active again, so
            // transient interruptions don't nag Face ID; only a real
            // background→foreground round trip re-locks (below).
            if model.requireBiometrics && scenePhase != .active {
                PrivacyShade()
            }
        }
        .task {
            await model.bootstrap()
        }
        .onChange(of: scenePhase) { _, phase in
            // Re-lock on leaving the foreground for real (background). Not on
            // .inactive — that fires for transient interruptions, and the
            // privacy shade already hides the content during them.
            if phase == .background && model.requireBiometrics {
                model.unlocked = false
            }
            // Returning to the foreground is a natural moment to deliver
            // queued offline writes and pick up new Apple Health samples.
            if phase == .active && model.authState == .signedIn {
                Task {
                    await model.drainOutbox()
                    await model.healthKit.sync(record: model.record)
                }
            }
        }
    }
}
