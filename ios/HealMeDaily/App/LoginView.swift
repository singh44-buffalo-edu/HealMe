import SwiftUI
import HealMeDailyKit

/// Sign-in card (mirrors the web shell's): local Medplum account against the
/// self-hosted server. Registration happens in the Medplum app (:3000),
/// never here. The server URL is editable up front because on a phone
/// "localhost" is never right — it must be the Mac's LAN address or a
/// tailnet/HTTPS hostname.
struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var showServerField = false

    var body: some View {
        @Bindable var model = model
        ZStack {
            T.canvas.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 18) {
                    Spacer(minLength: 60)
                    BrandMark(size: 52)
                    Text("HealMeNow")
                        .font(.ui(26, weight: .semibold))
                        .foregroundStyle(T.ink)
                    Text("Private personal health record — sign in with your local Medplum account")
                        .font(.ui(13))
                        .foregroundStyle(T.secondary)
                        .multilineTextAlignment(.center)
                    VaultChip()

                    DsCard(padding: 20) {
                        VStack(alignment: .leading, spacing: 14) {
                            VStack(alignment: .leading, spacing: 5) {
                                FieldLabel(text: "Email")
                                TextField("owner@example.com", text: $email)
                                    .textFieldStyle(BandFieldStyle())
                                    .keyboardType(.emailAddress)
                                    .textContentType(.username)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .accessibilityIdentifier("login.email")
                            }
                            VStack(alignment: .leading, spacing: 5) {
                                FieldLabel(text: "Password")
                                SecureField("••••••••", text: $password)
                                    .textFieldStyle(BandFieldStyle())
                                    .textContentType(.password)
                                    .accessibilityIdentifier("login.password")
                            }

                            if showServerField {
                                VStack(alignment: .leading, spacing: 5) {
                                    FieldLabel(text: "Medplum server URL")
                                    TextField("http://192.168.1.20:8103/", text: $model.serverURLString)
                                        .textFieldStyle(BandFieldStyle())
                                        .keyboardType(.URL)
                                        .textInputAutocapitalization(.never)
                                        .autocorrectionDisabled()
                                    Text("Your Mac's LAN IP or HTTPS hostname — not localhost.")
                                        .font(.mono(10))
                                        .foregroundStyle(T.quaternary)
                                }
                            } else {
                                Button {
                                    showServerField = true
                                } label: {
                                    Text("Server: \(model.serverURLString)")
                                        .font(.mono(10.5))
                                        .foregroundStyle(T.tertiary)
                                        .lineLimit(1)
                                }
                            }

                            // Security disclosure BEFORE the password is typed:
                            // plain http over an ordinary network is sniffable.
                            // Shown for the collapsed server line too — the
                            // stored URL is the one about to carry credentials.
                            TransportSecurityNotice(urlString: model.serverURLString)

                            if let error {
                                ErrorBanner(message: error)
                            }

                            PillButton(title: "Sign in", busy: busy) {
                                signIn()
                            }
                            .disabled(email.isEmpty || password.isEmpty)
                            .accessibilityIdentifier("login.signIn")
                        }
                    }
                    .padding(.horizontal, 20)

                    Text("Not medical advice — a personal record & discussion aid")
                        .font(.ui(11))
                        .foregroundStyle(T.quaternary)
                    Spacer(minLength: 40)
                }
                .frame(maxWidth: 480)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func signIn() {
        busy = true
        error = nil
        _Concurrency.Task {
            defer { busy = false }
            do {
                // Apply an edited server URL before authenticating against it.
                if showServerField {
                    await model.applyServerSettings()
                }
                try await model.signIn(email: email, password: password)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
