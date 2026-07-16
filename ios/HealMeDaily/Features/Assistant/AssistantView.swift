import SwiftUI
import HealMeDailyKit

/// Record-grounded AI Q&A — THE one indigo AI-identity surface of the app.
/// Everything on this screen is AI-derived and labeled as such (AIPill,
/// indigo cards); measured record data appears only inside citations, in
/// ink/mono. Safety invariants surfaced here (enforced server-side):
/// answers always carry citations + the not-medical-advice disclaimer,
/// cloud providers are named in an amber BoundaryRow BEFORE the user sends
/// anything, and NL quick capture only ever PROPOSES via the review queue —
/// nothing on this screen writes clinical data directly.
struct AssistantView: View {
    @Environment(AppModel.self) private var model

    // MARK: State

    @State private var status: AIService.Health?
    @State private var settings: AIService.AiSettings?
    @State private var statusLoaded = false

    @State private var question = ""
    @State private var asking = false
    @State private var conversation: [AssistantExchange] = []
    @State private var askError: String?

    @State private var quickText = ""
    @State private var quickBusy = false
    @State private var quickNote: Int?
    @State private var quickError: String?

    @State private var showHistory = false

    private var configured: Bool {
        status?.ai.configured == true
    }

    private var providerName: String? {
        status?.ai.provider
    }

    /// Per-feature route from AI settings. nil = unknown (settings fetch
    /// failed or feature missing from the table) — callers treat unknown as
    /// CLOUD, the conservative reading: when in doubt, show the data boundary.
    private func route(for feature: String) -> AIService.AiRoute? {
        settings?.routing[feature]
    }

    private var assistantRoute: AIService.AiRoute? { route(for: "assistant") }
    private var nlImportRoute: AIService.AiRoute? { route(for: "nl-import") }

    /// Recipient named in the amber BoundaryRow: the routed cloud provider,
    /// else the /health default provider, else a generic label — never blank.
    private var cloudRecipient: String {
        settings?.cloud_provider ?? providerName ?? "cloud provider"
    }

    /// Configured local provider's name for the green local chips.
    private var localProviderName: String {
        settings?.providers.first { $0.is_local }?.name ?? "local"
    }

    private var trimmedQuestion: String {
        question.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedQuick: String {
        quickText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Body

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                header

                if let askError {
                    ErrorBanner(message: askError)
                }

                if statusLoaded && !configured {
                    configureProviderCard
                }

                askCard

                ForEach(conversation) { exchange in
                    AssistantAnswerCard(exchange: exchange)
                }

                quickCaptureCard

                DisclaimerFooter()
            }
            .padding(16)
        }
        .background(T.canvas)
        .navigationTitle("Assistant")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showHistory = true
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                        .foregroundStyle(T.ai)
                }
                .accessibilityLabel("Question history")
            }
        }
        .sheet(isPresented: $showHistory) {
            AssistantHistorySheet()
        }
        .task {
            status = try? await model.ai.health()
            settings = try? await model.ai.aiSettings()
            statusLoaded = true
        }
    }

    // MARK: Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            PageHeader(
                title: "Assistant",
                subtitle: "Answers grounded in your record — every claim cited."
            )
            HStack(spacing: 8) {
                AIPill()
                Spacer()
                VaultChip()
            }
        }
    }

    /// "Configure a provider" state — the app must work with no AI key; this
    /// is an explanation, never an error wall.
    private var configureProviderCard: some View {
        DsCard(ai: true) {
            HStack {
                AIPill()
                Spacer()
            }
            Text("No AI provider is configured")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(T.ink)
            Text(status?.ai.reason ?? "AI service is not reachable — is it running on the server?")
                .font(.system(size: 12.5))
                .foregroundStyle(T.secondary)
            Text("Set up providers in AI settings (web app or Settings tab).")
                .font(.system(size: 12))
                .foregroundStyle(T.tertiary)
        }
    }

    private var askCard: some View {
        DsCard(ai: true) {
            HStack(spacing: 8) {
                Eyebrow(text: "Ask", color: T.ai)
                Spacer()
                if configured && assistantRoute != .off {
                    if assistantRoute == .local {
                        AssistantProviderChip(name: localProviderName, isLocal: true)
                    } else {
                        AssistantProviderChip(name: cloudRecipient, isLocal: false)
                    }
                }
            }

            // Cloud boundary is shown BEFORE the input — the user must see
            // where their data goes before they can send it. Unknown routing
            // over-discloses as cloud.
            if configured && assistantRoute != .off && assistantRoute != .local {
                BoundaryRow(recipient: cloudRecipient)
            }

            TextField("Ask about your record…", text: $question, axis: .vertical)
                .textFieldStyle(BandFieldStyle())
                .lineLimit(2...6)
                .disabled(asking)

            PillButton(title: "Ask about my record", variant: .ai, busy: asking) {
                ask()
            }
            .disabled(!configured || assistantRoute == .off || trimmedQuestion.isEmpty)

            if assistantRoute == .off {
                Text("AI is off for the assistant — enable it in AI settings.")
                    .font(.system(size: 11))
                    .foregroundStyle(T.quaternary)
            } else {
                Text("Reads your record, then answers — may take a minute.")
                    .font(.system(size: 11))
                    .foregroundStyle(T.quaternary)
            }
        }
        .disabled(!configured || assistantRoute == .off)
    }

    private var quickCaptureCard: some View {
        DsCard(ai: true) {
            HStack(spacing: 8) {
                Eyebrow(text: "Quick capture", color: T.ai)
                Spacer()
                if configured && nlImportRoute == .local {
                    AssistantProviderChip(name: localProviderName, isLocal: true)
                }
                AIPill()
            }

            TextField("e.g. weighed 71 kg this morning", text: $quickText, axis: .vertical)
                .textFieldStyle(BandFieldStyle())
                .lineLimit(1...4)
                .disabled(quickBusy)

            // Cloud boundary is shown BEFORE the propose button — the user
            // must see where their note goes before sending it. Unknown
            // routing over-discloses as cloud.
            if configured && nlImportRoute != .off && nlImportRoute != .local {
                BoundaryRow(recipient: cloudRecipient)
            }

            PillButton(title: "Propose to review queue", variant: .secondary, busy: quickBusy) {
                proposeQuickCapture()
            }
            .disabled(!configured || nlImportRoute == .off || trimmedQuick.isEmpty)

            if nlImportRoute == .off {
                Text("AI is off for quick capture — enable it in AI settings.")
                    .font(.system(size: 11))
                    .foregroundStyle(T.quaternary)
            }

            if let quickNote {
                // Review-gate invariant: proposals only — never worded as
                // saved/committed.
                (
                    Text("\(quickNote)").font(.mono(12, weight: .medium))
                    + Text(" proposals created — review them under Documents. Nothing was committed.")
                        .font(.system(size: 12))
                )
                .foregroundStyle(T.secondary)
            }

            if let quickError {
                ErrorBanner(message: quickError)
            }
        }
        .disabled(!configured || nlImportRoute == .off)
    }

    // MARK: Actions

    private func ask() {
        let q = trimmedQuestion
        guard !q.isEmpty, !asking else { return }
        asking = true
        askError = nil
        Task {
            do {
                let answer = try await model.ai.askAssistant(question: q)
                conversation.append(AssistantExchange(question: q, answer: answer))
                question = ""
            } catch {
                askError = error.localizedDescription
            }
            asking = false
        }
    }

    private func proposeQuickCapture() {
        let text = trimmedQuick
        guard !text.isEmpty, !quickBusy else { return }
        quickBusy = true
        quickError = nil
        quickNote = nil
        Task {
            do {
                let result = try await model.ai.nlImport(text: text)
                quickNote = result.proposals
                quickText = ""
                // Refresh the shared review-queue badge (More tab).
                await model.refreshCore()
            } catch {
                quickError = error.localizedDescription
            }
            quickBusy = false
        }
    }
}

// MARK: - One question + its answer

private struct AssistantExchange: Identifiable {
    let id = UUID()
    let question: String
    let answer: AIService.AssistantAnswer
}

// MARK: - Provider chip

/// Provider identity chip: local providers render green (data stays home),
/// cloud providers render in the AI indigo chip.
private struct AssistantProviderChip: View {
    let name: String
    let isLocal: Bool

    var body: some View {
        if isLocal {
            Text(name)
                .font(.mono(10))
                .foregroundStyle(T.green)
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(T.greenTint, in: Capsule())
        } else {
            Chip(text: name, ai: true)
        }
    }
}

// MARK: - Answer card

/// One Q&A exchange: AI-labeled answer with mandatory citations, grounding
/// read count, and the server's own disclaimer text.
private struct AssistantAnswerCard: View {
    let exchange: AssistantExchange

    var body: some View {
        DsCard(ai: true) {
            HStack(spacing: 8) {
                AIPill()
                AssistantProviderChip(
                    name: exchange.answer.provider.name,
                    isLocal: exchange.answer.provider.is_local
                )
                Spacer()
            }

            Eyebrow(text: "You asked")
            Text(exchange.question)
                .font(.system(size: 12.5))
                .foregroundStyle(T.secondary)

            hairline

            MarkdownText(markdown: exchange.answer.answer_markdown)

            if !exchange.answer.citations.isEmpty {
                hairline
                Eyebrow(text: "Citations")
                ForEach(exchange.answer.citations) { citation in
                    citationRow(citation)
                }
            }

            Text("grounded in \(exchange.answer.read_count) record reads")
                .font(.mono(10))
                .foregroundStyle(T.quaternary)

            Text(exchange.answer.disclaimer)
                .font(.system(size: 11))
                .foregroundStyle(T.quaternary)
        }
    }

    private var hairline: some View {
        Rectangle()
            .fill(T.hairline)
            .frame(height: 1)
    }

    private func citationRow(_ citation: AIService.AssistantCitation) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("[\(citation.n)]")
                .font(.mono(11, weight: .medium))
                .foregroundStyle(T.ai)
            VStack(alignment: .leading, spacing: 2) {
                Text(citation.display)
                    .font(.system(size: 12.5))
                    .foregroundStyle(T.ink)
                let meta = [citation.value, citation.date.map { Fmt.when($0) }]
                    .compactMap { $0 }
                    .joined(separator: " · ")
                if !meta.isEmpty {
                    Text(meta)
                        .font(.mono(11))
                        .foregroundStyle(T.quaternary)
                }
            }
        }
    }
}

// MARK: - History sheet

/// Past assistant sessions (stored as deletable Communications server-side).
/// Swipe-to-delete removes the session from the record, then reloads.
private struct AssistantHistorySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var sessions: [AIService.AssistantSession] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                        .tint(T.green)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List {
                        if let error {
                            ErrorBanner(message: error)
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                        }
                        if sessions.isEmpty && error == nil {
                            EmptyNote(text: "No previous questions")
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                        }
                        ForEach(sessions) { session in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(session.question)
                                    .font(.system(size: 13.5, weight: .medium))
                                    .foregroundStyle(T.ink)
                                Text(session.answer_preview)
                                    .font(.system(size: 12))
                                    .foregroundStyle(T.secondary)
                                    .lineLimit(3)
                                Text(Fmt.when(session.sent))
                                    .font(.mono(10))
                                    .foregroundStyle(T.quaternary)
                            }
                            .padding(.vertical, 2)
                            .listRowBackground(T.card)
                            .listRowSeparatorTint(T.hairline)
                        }
                        .onDelete(perform: delete)
                    }
                    .scrollContentBackground(.hidden)
                    .background(T.canvas)
                }
            }
            .background(T.canvas)
            .navigationTitle("Assistant history")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                    .tint(T.green)
                }
            }
            .task {
                await load()
            }
        }
    }

    private func load() async {
        loading = true
        do {
            sessions = try await model.ai.assistantSessions()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func delete(at offsets: IndexSet) {
        let ids = offsets.map { sessions[$0].id }
        Task {
            do {
                for id in ids {
                    try await model.ai.deleteAssistantSession(id: id)
                }
            } catch {
                self.error = error.localizedDescription
            }
            await load()
        }
    }
}
