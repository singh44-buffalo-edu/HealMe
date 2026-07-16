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
        }
        .task {
            await model.bootstrap()
        }
        .onChange(of: scenePhase) { _, phase in
            // Re-lock whenever the app leaves the foreground.
            if phase == .background && model.requireBiometrics {
                model.unlocked = false
            }
        }
    }
}
