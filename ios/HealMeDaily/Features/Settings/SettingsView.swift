import SwiftUI
import HealMeDailyKit

/// Settings — server configuration, security, reminders, AI routing and
/// account. Form-styled counterpart of the web Settings + AI Settings pages.
///
/// Safety notes honored here:
/// - AI routing rows only ROUTE — every actual cloud call still writes its
///   boundary-ledger AuditEvent server-side, and a BoundaryRow names the
///   cloud provider whenever any feature routes there.
/// - API keys are never stored on this phone; key management stays on the
///   web AI-settings page.
/// - Turning the biometric gate ON also unlocks the current session so the
///   owner is not instantly locked out of the screen they are looking at.
struct SettingsView: View {
    @Environment(AppModel.self) private var model

    // AI section state (loaded from the ai-service; nil until fetched)
    @State private var aiHealth: AIService.Health?
    @State private var aiSettings: AIService.AiSettings?
    @State private var aiLoading = false
    @State private var aiError: String?

    @State private var applyingServer = false
    @State private var signingOut = false

    /// The four per-feature routing switches the ai-service exposes.
    private static let aiFeatures = ["health-review", "ingest-extraction", "assistant", "nl-import"]

    var body: some View {
        @Bindable var model = model
        Form {
            // MARK: Server
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    FieldLabel(text: "Medplum server URL")
                    TextField("http://localhost:8103/", text: $model.serverURLString)
                        .font(.mono(13))
                        .foregroundStyle(T.ink)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                VStack(alignment: .leading, spacing: 6) {
                    FieldLabel(text: "AI service URL")
                    TextField("http://localhost:8000/", text: $model.aiServiceURLString)
                        .font(.mono(13))
                        .foregroundStyle(T.ink)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                PillButton(title: "Apply server settings", variant: .secondary, busy: applyingServer) {
                    Task {
                        applyingServer = true
                        await model.applyServerSettings()
                        applyingServer = false
                        // The AI service may have moved too — re-probe it.
                        await loadAi()
                    }
                }
            } header: {
                Text("Server")
            } footer: {
                Text("Changing the Medplum URL signs you out (tokens are bound to the server that minted them).")
            }
            .listRowBackground(T.card)

            // MARK: Security
            Section {
                Toggle(isOn: $model.requireBiometrics) {
                    Text("Require Face ID / passcode")
                        .font(.system(size: 14))
                        .foregroundStyle(T.ink)
                }
                .tint(T.green)
                .onChange(of: model.requireBiometrics) { _, isOn in
                    // Turning the gate ON must not lock out the session the
                    // owner is currently in — unlock now, gate next launch.
                    if isOn {
                        model.unlocked = true
                    }
                }
            } header: {
                Text("Security")
            } footer: {
                Text("Health data stays hidden until the phone owner authenticates.")
            }
            .listRowBackground(T.card)

            // MARK: Dose reminders
            Section {
                Toggle(isOn: $model.remindersEnabled) {
                    Text("Dose reminders")
                        .font(.system(size: 14))
                        .foregroundStyle(T.ink)
                }
                .tint(T.green)
                .onChange(of: model.remindersEnabled) { _, _ in
                    model.remindersSettingChanged()
                }
                Toggle(isOn: $model.remindersShowMedName) {
                    Text("Show medication name on lock screen")
                        .font(.system(size: 14))
                        .foregroundStyle(model.remindersEnabled ? T.ink : T.disabled)
                }
                .tint(T.green)
                .disabled(!model.remindersEnabled)
                .onChange(of: model.remindersShowMedName) { _, _ in
                    // Reschedule so pending notifications adopt the new
                    // lock-screen privacy setting immediately.
                    model.remindersSettingChanged()
                }
            } header: {
                Text("Dose reminders")
            } footer: {
                Text("Reminders are computed on this phone from your schedule — nothing is sent anywhere. Default hides med names from the lock screen.")
            }
            .listRowBackground(T.card)

            healthKitSection
            aiSection
            accountSection
            aboutSection
        }
        .scrollContentBackground(.hidden)
        .background(T.canvas)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                VaultChip()
            }
        }
        .task {
            await loadAi()
        }
    }

    // MARK: - AI

    private var aiSection: some View {
        Section {
            if aiLoading && aiHealth == nil {
                HStack(spacing: 8) {
                    ProgressView()
                        .tint(T.green)
                    Text("Checking AI service…")
                        .font(.system(size: 13))
                        .foregroundStyle(T.secondary)
                }
            }
            if let aiError {
                ErrorBanner(message: aiError)
            }
            if let aiHealth {
                providerRow(aiHealth.ai)
            }
            if let aiSettings {
                // Cloud boundary is never implicit: whenever any feature
                // routes to cloud, name the recipient right here.
                if let cloud = aiSettings.cloud_provider, aiSettings.routing.values.contains(.cloud) {
                    BoundaryRow(recipient: cloud)
                }
                ForEach(Self.aiFeatures, id: \.self) { feature in
                    routeRow(feature)
                }
            }
        } header: {
            Text("AI")
        } footer: {
            Text(
                "'cloud' sends record contents to the chosen provider — every cloud call is logged "
                    + "to the boundary ledger first. API keys are managed on the web AI-settings page "
                    + "(never stored on this phone)."
            )
        }
        .listRowBackground(T.card)
    }

    private func providerRow(_ status: AIService.AiStatus) -> some View {
        HStack(alignment: .top, spacing: 10) {
            StatusDot(color: status.configured ? T.green : T.quaternary)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(status.provider ?? "No provider")
                    .font(.mono(13, weight: .medium))
                    .foregroundStyle(T.ink)
                if status.configured {
                    if let modelName = status.model {
                        Text(modelName)
                            .font(.mono(11))
                            .foregroundStyle(T.tertiary)
                    }
                } else {
                    Text(status.reason ?? "not configured")
                        .font(.mono(11))
                        .foregroundStyle(T.quaternary)
                }
            }
            Spacer()
            Text(status.configured ? "configured" : "not configured")
                .font(.mono(10, weight: .medium))
                .foregroundStyle(status.configured ? T.green : T.quaternary)
        }
    }

    private func routeRow(_ feature: String) -> some View {
        Picker(selection: routeBinding(feature)) {
            ForEach(AIService.AiRoute.allCases, id: \.self) { route in
                Text(route.rawValue)
                    .font(.mono(12))
                    .tag(route)
            }
        } label: {
            Text(feature)
                .font(.mono(12))
                .foregroundStyle(T.ink)
        }
        .pickerStyle(.menu)
        .tint(T.ink)
    }

    /// Optimistic route binding: flip locally so the menu doesn't snap back,
    /// persist via the ai-service, revert + surface the error on failure.
    private func routeBinding(_ feature: String) -> Binding<AIService.AiRoute> {
        Binding(
            get: { aiSettings?.routing[feature] ?? .off },
            set: { newRoute in
                let previous = aiSettings?.routing[feature] ?? .off
                guard newRoute != previous else { return }
                aiSettings?.routing[feature] = newRoute
                Task {
                    do {
                        aiError = nil
                        aiSettings = try await model.ai.updateAiSettings(routing: [feature: newRoute])
                    } catch {
                        aiSettings?.routing[feature] = previous
                        aiError = error.localizedDescription
                    }
                }
            }
        )
    }

    private func loadAi() async {
        aiLoading = true
        defer { aiLoading = false }
        do {
            aiError = nil
            aiHealth = try await model.ai.health()
            aiSettings = try await model.ai.aiSettings()
        } catch {
            aiError = error.localizedDescription
        }
    }

    // MARK: - Account

    // MARK: - Apple Health

    /// Opt-in, read-only Apple Health → own-server sync. The toggle drives
    /// HealthKitService; status/last-sync render verbatim from it.
    private var healthKitSection: some View {
        Section {
            if model.healthKit.status == .unavailable {
                Text("Apple Health is not available on this device.")
                    .font(.system(size: 13))
                    .foregroundStyle(T.secondary)
            } else {
                Toggle(isOn: Binding(
                    get: { model.healthKit.status == .on || model.healthKit.status == .requesting },
                    set: { turnOn in
                        Task {
                            if turnOn {
                                await model.healthKit.enable(record: model.record)
                            } else {
                                model.healthKit.disable()
                            }
                        }
                    }
                )) {
                    Text("Sync Apple Health")
                        .font(.system(size: 14))
                        .foregroundStyle(T.ink)
                }
                .tint(T.green)

                if model.healthKit.status == .on {
                    HStack {
                        Text(model.healthKit.syncing ? "Syncing…" : "Last sync")
                            .font(.system(size: 14))
                            .foregroundStyle(T.secondary)
                        Spacer()
                        if let at = model.healthKit.lastSyncAt {
                            Text("\(Fmt.when(RecordAPI.isoInstant(at)))\(model.healthKit.lastSummary.map { " · \($0)" } ?? "")")
                                .font(.mono(11))
                                .foregroundStyle(T.tertiary)
                        }
                    }
                    PillButton(title: "Sync now", variant: .secondary, busy: model.healthKit.syncing) {
                        Task { await model.healthKit.sync(record: model.record) }
                    }
                }
                if let error = model.healthKit.lastError {
                    Text(error)
                        .font(.system(size: 12))
                        .foregroundStyle(T.outOfRange)
                }
            }
        } header: {
            Text("Apple Health")
        } footer: {
            Text(
                "Read-only: steps, resting heart rate, HRV, sleep, weight, blood pressure, SpO₂ and "
                    + "temperature go from this phone to your own server. Nothing is written back to "
                    + "Apple Health, and nothing goes anywhere else."
            )
        }
        .listRowBackground(T.card)
    }

    private var accountSection: some View {
        Section {
            HStack {
                Text("Signed in as")
                    .font(.system(size: 14))
                    .foregroundStyle(T.secondary)
                Spacer()
                Text(model.profileName)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(T.ink)
            }
            HStack {
                Text("Server")
                    .font(.system(size: 14))
                    .foregroundStyle(T.secondary)
                Spacer()
                Text(model.serverURLString)
                    .font(.mono(12))
                    .foregroundStyle(T.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            // Queued offline writes — visible so sign-out never silently
            // holds undelivered health data (the queue drains after the
            // next sign-in to the same server).
            if model.pendingWrites > 0 {
                HStack {
                    Text("Waiting to sync")
                        .font(.system(size: 14))
                        .foregroundStyle(T.secondary)
                    Spacer()
                    Text("\(model.pendingWrites) change\(model.pendingWrites == 1 ? "" : "s")")
                        .font(.mono(12))
                        .foregroundStyle(T.watch)
                }
            }
            Button {
                Task {
                    signingOut = true
                    await model.signOut()
                    signingOut = false
                }
            } label: {
                HStack(spacing: 7) {
                    if signingOut {
                        ProgressView()
                            .controlSize(.small)
                            .tint(T.outOfRange)
                    }
                    Text("Sign out")
                        .font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(T.outOfRange)
                .frame(maxWidth: .infinity)
            }
            .disabled(signingOut)
        } header: {
            Text("Account")
        }
        .listRowBackground(T.card)
    }

    // MARK: - About

    private var aboutSection: some View {
        Section {
            HStack {
                Text("Version")
                    .font(.system(size: 14))
                    .foregroundStyle(T.secondary)
                Spacer()
                Text(appVersion)
                    .font(.mono(12))
                    .foregroundStyle(T.ink)
            }
            Text("Your record lives on your own self-hosted Medplum server. This app never talks to anyone else's cloud unless you route an AI feature there.")
                .font(.system(size: 12.5))
                .foregroundStyle(T.secondary)
            DisclaimerFooter()
        } header: {
            Text("About")
        }
        .listRowBackground(T.card)
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        if let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String {
            return "\(version) (\(build))"
        }
        return version
    }
}
