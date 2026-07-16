import SwiftUI
import LocalAuthentication

/// Full-screen biometric gate. Health data stays hidden until Face ID /
/// Touch ID / device passcode succeeds.
struct LockView: View {
    @Environment(AppModel.self) private var model
    @State private var failed = false

    var body: some View {
        ZStack {
            T.canvas.ignoresSafeArea()
            VStack(spacing: 16) {
                BrandMark(size: 44)
                Text("HealMeDaily is locked")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(T.ink)
                if failed {
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
        let context = LAContext()
        var error: NSError?
        // Device passcode fallback included — being locked out of your own
        // health record is worse than passcode-level protection.
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            model.unlocked = true // no passcode set on device — nothing to gate with
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock your health record") { success, _ in
            DispatchQueue.main.async {
                if success {
                    model.unlocked = true
                } else {
                    failed = true
                }
            }
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
