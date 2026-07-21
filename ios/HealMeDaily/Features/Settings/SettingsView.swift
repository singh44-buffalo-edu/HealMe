import SwiftUI
import HealMeDailyKit

/// Settings — server configuration, security, reminders, AI routing and
/// account. Form-styled counterpart of the web Settings + AI Settings pages.
///
/// Safety notes honored here:
/// - AI routing rows only ROUTE — every actual cloud call still writes its
///   boundary-ledger AuditEvent server-side, and a BoundaryRow names the
///   cloud provider whenever any feature routes there.
/// - BYOK keys are entered here but stored ONLY in the server keystore
///   (Keychain / 0600 file on the owner's server) — never persisted on this
///   phone. The raw key rides one authenticated request and is dropped from
///   view state the instant it is transmitted; the UI only ever shows the
///   server's masked echo afterwards.
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

    // BYOK key-management transient state. Raw keys live ONLY in `keyDrafts`
    // and only until the Save request returns — never persisted, never read
    // back (the server echoes a masked form via aiSettings).
    @State private var keyDrafts: [String: String] = [:]
    @State private var savingKey: String?
    @State private var removingKey: String?
    @State private var testing: String?
    @State private var testResults: [String: TestOutcome] = [:]
    @State private var openaiBaseURLDraft = ""
    @State private var savingBaseURL = false

    /// Inline connectivity-test outcome — a local view type, not
    /// AIService.AiTestResult: the failure path needs to synthesize one and the
    /// Kit's memberwise init is internal (never constructible cross-module).
    private enum TestOutcome {
        case ok(latencyMs: Double?, model: String?)
        case fail(String)
    }

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
                    // Amber disclosure when this URL is genuinely cleartext
                    // (plain http beyond loopback/Tailscale) — live as typed.
                    TransportSecurityNotice(urlString: model.serverURLString)
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
                        .font(.ui(14))
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
                        .font(.ui(14))
                        .foregroundStyle(T.ink)
                }
                .tint(T.green)
                .onChange(of: model.remindersEnabled) { _, _ in
                    model.remindersSettingChanged()
                }
                Toggle(isOn: $model.remindersShowMedName) {
                    Text("Show medication name on lock screen")
                        .font(.ui(14))
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

            pushSection
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
                        .font(.ui(13))
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
                cloudProviderPicker(aiSettings)
                ForEach(cloudProviders(aiSettings)) { provider in
                    keyRow(provider)
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
                    + "to the boundary ledger first. API keys are entered here but live ONLY in your "
                    + "server's keystore (Keychain / 0600 file); this phone keeps no copy — the raw key "
                    + "is dropped the moment it is sent."
            )
        }
        .listRowBackground(T.card)
    }

    /// Cloud (non-local) providers, in the server's order.
    private func cloudProviders(_ settings: AIService.AiSettings) -> [AIService.AiProviderInfo] {
        settings.providers.filter { !$0.is_local }
    }

    private func providerLabel(_ name: String) -> String {
        switch name {
        case "anthropic": return "Anthropic"
        case "openai": return "OpenAI"
        case "gemini": return "Gemini"
        case "ollama": return "Ollama"
        default: return name.capitalized
        }
    }

    /// Which provider a "cloud"-routed feature talks to. Persisted server-side
    /// so every client agrees. Optimistic + revert, mirroring routeBinding.
    private func cloudProviderPicker(_ settings: AIService.AiSettings) -> some View {
        let providers = cloudProviders(settings)
        let current = settings.cloud_provider ?? providers.first?.name ?? ""
        return Picker(selection: Binding(
            get: { current },
            set: { newName in
                guard newName != current else { return }
                let previous = current
                aiSettings?.cloud_provider = newName
                Task {
                    do {
                        aiError = nil
                        aiSettings = try await model.ai.updateAiSettings(cloudProvider: newName)
                    } catch {
                        aiSettings?.cloud_provider = previous
                        aiError = error.localizedDescription
                    }
                }
            }
        )) {
            ForEach(providers) { provider in
                Text(providerLabel(provider.name))
                    .font(.mono(12))
                    .tag(provider.name)
            }
        } label: {
            Text("cloud provider")
                .font(.mono(12))
                .foregroundStyle(T.ink)
        }
        .pickerStyle(.menu)
        .tint(T.ink)
    }

    /// One cloud provider's BYOK controls: masked-key status, a SecureField to
    /// enter/replace the key, Save/Remove/Test actions, and (OpenAI only) a
    /// custom-endpoint field. The raw key never leaves `keyDrafts` and is
    /// cleared the instant Save succeeds.
    private func keyRow(_ provider: AIService.AiProviderInfo) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                StatusDot(color: provider.configured ? T.green : T.quaternary, size: 6)
                Text(providerLabel(provider.name))
                    .font(.mono(13, weight: .medium))
                    .foregroundStyle(T.ink)
                Spacer()
                if provider.configured {
                    Text(provider.masked_key ?? "configured")
                        .font(.mono(11))
                        .foregroundStyle(T.green)
                } else {
                    Text("no key")
                        .font(.mono(10, weight: .medium))
                        .foregroundStyle(T.quaternary)
                }
            }

            HStack(spacing: 8) {
                SecureField(
                    provider.configured ? "paste a new key to replace" : "paste your key",
                    text: keyDraftBinding(provider.name)
                )
                .font(.mono(12))
                .foregroundStyle(T.ink)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                // No .textContentType(.password): that opts the field into
                // AutoFill and lets iOS offer to save the key into the iCloud
                // Keychain — on-device persistence + iCloud egress of a raw LLM
                // key, which the server-managed contract forbids.
                actionButton(
                    "Save",
                    busy: savingKey == provider.name,
                    disabled: (keyDrafts[provider.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ) { saveKey(provider.name) }
            }

            if provider.name == "openai" {
                VStack(alignment: .leading, spacing: 4) {
                    FieldLabel(text: "Custom endpoint (OpenAI-compatible)")
                    HStack(spacing: 8) {
                        TextField("https://api.openai.com/v1", text: $openaiBaseURLDraft)
                            .font(.mono(11))
                            .foregroundStyle(T.ink)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        actionButton("Set", busy: savingBaseURL) { saveBaseURL() }
                    }
                }
            }

            HStack(spacing: 16) {
                actionButton("Test", color: T.ink, busy: testing == provider.name) {
                    testKey(provider.name)
                }
                if provider.configured {
                    actionButton("Remove", color: T.outOfRange, busy: removingKey == provider.name) {
                        removeKey(provider.name)
                    }
                }
                Spacer()
                testOutcomeView(provider.name)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func testOutcomeView(_ provider: String) -> some View {
        switch testResults[provider] {
        case let .ok(latencyMs, model):
            let latency = latencyMs.map { " · \(Int($0))ms" } ?? ""
            let modelText = model.map { " · \($0)" } ?? ""
            Text("✓ ok\(latency)\(modelText)")
                .font(.mono(10, weight: .medium))
                .foregroundStyle(T.green)
                .lineLimit(1)
                .truncationMode(.tail)
        case let .fail(reason):
            Text("✕ \(reason)")
                .font(.mono(10))
                .foregroundStyle(T.outOfRange)
                .lineLimit(2)
                .multilineTextAlignment(.trailing)
        case .none:
            EmptyView()
        }
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
            // Seed the custom-endpoint field from the persisted value so an
            // already-configured endpoint is shown (and a blank Set doesn't
            // silently clear it). Skip mid-save to avoid clobbering an edit.
            if !savingBaseURL {
                openaiBaseURLDraft = aiSettings?.providers.first { $0.name == "openai" }?.base_url ?? ""
            }
        } catch {
            aiError = error.localizedDescription
        }
    }

    // MARK: - Account

    // MARK: - Push notifications

    /// Opt-in server-driven push. The device token registers with the owner's
    /// own ai-service; no APNs secret ever lives in the app, and payloads
    /// carry no medication name.
    private var pushSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { model.push.status == .on || model.push.status == .requesting },
                set: { turnOn in
                    Task {
                        if turnOn {
                            await model.push.enable()
                        } else {
                            await model.push.disable()
                        }
                    }
                }
            )) {
                Text("Push notifications")
                    .font(.ui(14))
                    .foregroundStyle(T.ink)
            }
            .tint(T.green)

            if model.push.status == .denied {
                Text("Notifications are turned off for HealMeNow in iOS Settings — enable them there first.")
                    .font(.ui(12))
                    .foregroundStyle(T.watch)
            }
            if let error = model.push.lastError {
                Text(error)
                    .font(.ui(12))
                    .foregroundStyle(T.outOfRange)
            }
        } header: {
            Text("Push notifications")
        } footer: {
            Text(
                "Server-sent reminders (e.g. an overdue dose) from your own stack. The alert says only "
                    + "that a reminder is waiting — never the medication name — and tapping it opens Today. "
                    + "Requires the server's APNs credentials; without them nothing is sent."
            )
        }
        .listRowBackground(T.card)
    }

    // MARK: - Apple Health

    /// Opt-in, read-only Apple Health → own-server sync. The toggle drives
    /// HealthKitService; status/last-sync render verbatim from it.
    private var healthKitSection: some View {
        Section {
            if model.healthKit.status == .unavailable {
                Text("Apple Health is not available on this device.")
                    .font(.ui(13))
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
                        .font(.ui(14))
                        .foregroundStyle(T.ink)
                }
                .tint(T.green)

                if model.healthKit.status == .on {
                    HStack {
                        Text(model.healthKit.syncing ? "Syncing…" : "Last sync")
                            .font(.ui(14))
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
                        .font(.ui(12))
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
                    .font(.ui(14))
                    .foregroundStyle(T.secondary)
                Spacer()
                Text(model.profileName)
                    .font(.ui(14, weight: .medium))
                    .foregroundStyle(T.ink)
            }
            HStack {
                Text("Server")
                    .font(.ui(14))
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
                        .font(.ui(14))
                        .foregroundStyle(T.secondary)
                    Spacer()
                    Text("\(model.pendingWrites) change\(model.pendingWrites == 1 ? "" : "s")")
                        .font(.mono(12))
                        .foregroundStyle(T.watch)
                }
            }
            // Held, not dropped: entries queued under a different sign-in
            // sync only under the sign-in that recorded them.
            if model.heldForOtherProfile > 0 {
                let held = model.heldForOtherProfile
                Text("\(held) change\(held == 1 ? " is" : "s are") held from a previous sign-in — sign back in with that account to sync \(held == 1 ? "it" : "them").")
                    .font(.ui(12))
                    .foregroundStyle(T.watch)
            }
            // One-time notice: a corrupt offline-changes file was preserved
            // beside the queue instead of being overwritten.
            if let setAside = model.outboxCorruptFileNotice {
                Text("Some offline changes could not be read and were set aside (\(setAside)) — they will not sync automatically.")
                    .font(.ui(12))
                    .foregroundStyle(T.watch)
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
                        .font(.ui(14, weight: .semibold))
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
                    .font(.ui(14))
                    .foregroundStyle(T.secondary)
                Spacer()
                Text(appVersion)
                    .font(.mono(12))
                    .foregroundStyle(T.ink)
            }
            Text("Your record lives on your own self-hosted Medplum server. This app never talks to anyone else's cloud unless you route an AI feature there.")
                .font(.ui(12.5))
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

// MARK: - BYOK key-management actions
//
// The phone is a REMOTE CONTROL for the server keystore: keys are transmitted
// here but never persisted on-device. Split into an extension so the view
// struct stays within the type-body-length budget.
private extension SettingsView {
    /// Compact inline action button (mono label), matching the Sign-out button
    /// pattern rather than the full-width PillButton.
    func actionButton(
        _ title: String,
        color: Color = T.ink,
        busy: Bool = false,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if busy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(color)
                }
                Text(title)
                    .font(.mono(12, weight: .medium))
            }
            .foregroundStyle(disabled ? T.quaternary : color)
        }
        .buttonStyle(.plain)
        .disabled(disabled || busy)
    }

    func keyDraftBinding(_ provider: String) -> Binding<String> {
        Binding(
            get: { keyDrafts[provider] ?? "" },
            set: { keyDrafts[provider] = $0 }
        )
    }

    /// Transmit the pasted key to the SERVER keystore, then immediately drop it
    /// from view state — the phone never retains a raw key. Reloads settings so
    /// the masked echo + configured state refresh.
    func saveKey(_ provider: String) {
        let raw = (keyDrafts[provider] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, savingKey == nil else { return }
        savingKey = provider
        Task {
            defer { savingKey = nil }
            do {
                aiError = nil
                _ = try await model.ai.setProviderKey(provider, key: raw)
                keyDrafts[provider] = "" // raw key never retained on-device
                testResults[provider] = nil // any prior test result is now stale
                await loadAi()
            } catch {
                aiError = error.localizedDescription
            }
        }
    }

    func removeKey(_ provider: String) {
        guard removingKey == nil else { return }
        removingKey = provider
        Task {
            defer { removingKey = nil }
            do {
                aiError = nil
                try await model.ai.deleteProviderKey(provider)
                testResults[provider] = nil
                await loadAi()
            } catch {
                aiError = error.localizedDescription
            }
        }
    }

    func testKey(_ provider: String) {
        guard testing == nil else { return }
        testing = provider
        Task {
            defer { testing = nil }
            do {
                aiError = nil
                let result = try await model.ai.testProvider(provider)
                testResults[provider] = result.ok
                    ? .ok(latencyMs: result.latency_ms, model: result.model)
                    : .fail(result.reason ?? "test failed")
            } catch {
                testResults[provider] = .fail(error.localizedDescription)
            }
        }
    }

    /// Persist the OpenAI custom endpoint (empty string clears it). Routing/keys
    /// are untouched — this only maps openai → base URL server-side.
    func saveBaseURL() {
        guard !savingBaseURL else { return }
        let url = openaiBaseURLDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        savingBaseURL = true
        Task {
            defer { savingBaseURL = false }
            do {
                aiError = nil
                aiSettings = try await model.ai.updateAiSettings(baseUrls: ["openai": url])
            } catch {
                aiError = error.localizedDescription
            }
        }
    }
}
