import SwiftUI
import LocalAuthentication

/// Full-screen biometric gate. Health data stays hidden until Face ID /
/// Touch ID / device passcode succeeds.
struct LockView: View {
    @Environment(AppModel.self) private var model
    @State private var failed = false
    /// The device has no passcode/biometrics, so there is no OS auth to gate
    /// with — surface an explicit choice instead of silently unlocking.
    @State private var noPasscode = false

    var body: some View {
        ZStack {
            T.canvas.ignoresSafeArea()
            VStack(spacing: 16) {
                BrandMark(size: 44)
                Text("HealMeDaily is locked")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(T.ink)

                if noPasscode {
                    // No silent bypass: the owner enabled the lock but the
                    // device has no passcode. Explain, and require a conscious
                    // tap to proceed unprotected (or go set a passcode).
                    Text("This iPhone has no passcode, so the record can't be locked. Set a passcode in iOS Settings for protection.")
                        .font(.system(size: 13))
                        .foregroundStyle(T.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    PillButton(title: "Continue without lock") {
                        model.unlocked = true
                    }
                    .frame(maxWidth: 240)
                } else if failed {
                    PillButton(title: "Unlock") {
                        authenticate()
                    }
                    .frame(maxWidth: 220)
                }
            }
        }
        .onAppear {
            authenticate()
        }
    }

    private func authenticate() {
        failed = false
        noPasscode = false
        let context = LAContext()
        var error: NSError?
        // Device passcode fallback included — being locked out of your own
        // health record is worse than passcode-level protection.
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // No passcode/biometrics enrolled: do NOT silently unlock — show
            // the explicit no-passcode state so exposure is a conscious choice.
            noPasscode = true
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock your health record") { success, _ in
            _Concurrency.Task { @MainActor in
                if success {
                    model.unlocked = true
                } else {
                    failed = true
                }
            }
        }
    }
}

/// Opaque cover shown while the app is not active, so the health record never
/// appears in the app-switcher snapshot. No auth — purely visual privacy.
struct PrivacyShade: View {
    var body: some View {
        ZStack {
            T.canvas.ignoresSafeArea()
            BrandMark(size: 44)
        }
    }
}

/// The round green "H" brand mark from the web shell.
struct BrandMark: View {
    var size: CGFloat = 30

    var body: some View {
        Text("H")
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(T.green, in: Circle())
    }
}
