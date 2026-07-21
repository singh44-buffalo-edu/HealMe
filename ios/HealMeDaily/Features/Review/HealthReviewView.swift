import SwiftUI
import HealMeDailyKit

/// AI Health Review + deterministic data summary — iOS counterpart of the
/// web Health Review page. Two generators share one result shape:
///   · "Data-only summary" — deterministic, no AI, always available.
///   · "Generate AI review" — one LLM round trip; gated on a configured
///     provider, with the amber BoundaryRow shown BEFORE any cloud send.
/// Provenance rules (three-data-classes): fresh results are labeled from the
/// button that made them; a stored latest is labeled AI only when its
/// description says so — unknown provenance gets no AI pill but keeps the
/// disclaimer. Organizes only — never diagnoses, never doses.
struct HealthReviewView: View {
    @Environment(AppModel.self) private var model

    /// How a displayed review came to be — drives the AI pill vs. the
    /// "deterministic · no AI" chip (or neither, when unknown).
    private enum Provenance {
        case ai
        case deterministic
        case unknown
    }

    private static let windowOptions = [30, 90, 180]

    // Stored latest (loaded on appear; 404 → nil).
    @State private var latest: AIService.ReviewResult?
    // Freshly generated result (takes display precedence over `latest`).
    @State private var fresh: AIService.ReviewResult?
    @State private var freshProvenance: Provenance = .unknown

    @State private var windowDays = 90 // owner default
    @State private var generatingAI = false
    @State private var generatingData = false
    @State private var initialLoaded = false

    // AI availability (from /health, provider locality from /ai/settings).
    @State private var aiConfigured = false
    @State private var aiUnavailableNote: String?
    /// Non-nil ⇒ the configured provider is cloud; value is the recipient
    /// name for the BoundaryRow.
    @State private var cloudProviderName: String?

    @State private var pdfURL: URL?
    @State private var loadingPdf = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    VaultChip()
                    Spacer()
                }

                if let errorMessage {
                    ErrorBanner(message: errorMessage)
                }

                generateCard

                if !initialLoaded {
                    HStack {
                        Spacer()
                        ProgressView().tint(T.green)
                        Spacer()
                    }
                    .padding(.vertical, 20)
                } else if let shown = displayed {
                    resultCard(shown.review, provenance: shown.provenance)
                } else {
                    DsCard {
                        EmptyNote(text: "No review yet — generate one above.")
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    DisclaimerFooter()
                    Text("Organizes your record for a clinician conversation — it never diagnoses or gives dosing advice.")
                        .font(.ui(11))
                        .foregroundStyle(T.quaternary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(16)
        }
        .background(T.canvas)
        .navigationTitle("Health Review")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadInitial() }
        .onDisappear {
            // The PDF is a share artifact, not a store: it exists only while
            // this screen is up. Leaving the screen fires onDisappear (a
            // presented share sheet does NOT — the file stays readable while
            // the sheet is showing), so delete here and drop the URL so a
            // revisit refetches instead of sharing a deleted file.
            pdfURL = nil
            Self.removePdfFile()
        }
    }

    // MARK: Generate card

    private var generateCard: some View {
        DsCard {
            Eyebrow(text: "Generate")

            // Window picker: 30 / 90 / 180 days (90 = owner default).
            HStack(spacing: 6) {
                ForEach(Self.windowOptions, id: \.self) { days in
                    Button {
                        windowDays = days
                    } label: {
                        Text("\(days)d")
                            .font(.mono(12, weight: windowDays == days ? .semibold : .regular))
                            .foregroundStyle(windowDays == days ? T.green : T.tertiary)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .background(windowDays == days ? T.greenTint : T.band, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }

            PillButton(title: "Data-only summary", variant: .secondary, busy: generatingData) {
                generate(useAI: false)
            }
            .disabled(generatingAI)
            Text("Deterministic — built from your record only, no AI involved.")
                .font(.ui(11.5))
                .foregroundStyle(T.tertiary)

            Rectangle()
                .fill(T.hairline)
                .frame(height: 1)
                .padding(.vertical, 2)

            // Cloud boundary is disclosed BEFORE the user can send anything.
            if aiConfigured, let cloudProviderName {
                BoundaryRow(recipient: cloudProviderName)
            }

            PillButton(title: "Generate AI review", variant: .ai, busy: generatingAI) {
                generate(useAI: true)
            }
            .disabled(!aiConfigured || generatingData)
            .opacity(aiConfigured ? 1 : 0.45)

            if aiConfigured {
                Text("One model round trip — may take a minute.")
                    .font(.ui(11.5))
                    .foregroundStyle(T.tertiary)
            } else {
                Text(aiUnavailableNote ?? "Checking AI configuration…")
                    .font(.ui(11.5))
                    .foregroundStyle(T.tertiary)
            }
        }
    }

    // MARK: Result card

    private func resultCard(_ review: AIService.ReviewResult, provenance: Provenance) -> some View {
        DsCard(ai: provenance == .ai) {
            HStack(alignment: .top) {
                Eyebrow(text: "Latest review")
                Spacer()
                switch provenance {
                case .ai:
                    AIPill()
                case .deterministic:
                    Chip(text: "deterministic · no AI")
                case .unknown:
                    // Stored review of unknown provenance: no AI pill (never
                    // guess a label), disclaimer still applies below.
                    EmptyView()
                }
            }

            if let description = review.description, !description.isEmpty {
                Text(description)
                    .font(.ui(14, weight: .semibold))
                    .foregroundStyle(T.ink)
            }

            HStack(spacing: 6) {
                Text(Fmt.when(review.generated_at))
                    .font(.mono(11))
                    .foregroundStyle(T.secondary)
                if let days = review.window_days {
                    Text("·")
                        .font(.mono(11))
                        .foregroundStyle(T.quaternary)
                    Text("\(days)-day window")
                        .font(.mono(11))
                        .foregroundStyle(T.secondary)
                }
            }

            Rectangle()
                .fill(T.hairline)
                .frame(height: 1)

            MarkdownText(markdown: review.markdown)

            Rectangle()
                .fill(T.hairline)
                .frame(height: 1)

            Text("Not medical advice — a discussion aid; review with a qualified clinician.")
                .font(.ui(11))
                .foregroundStyle(T.quaternary)

            if let pdfURL {
                ShareLink(item: pdfURL) {
                    HStack(spacing: 7) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.ui(13, weight: .semibold))
                        Text("health-review.pdf")
                            .font(.mono(13, weight: .semibold))
                    }
                    .foregroundStyle(T.ink)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 46)
                    .background(T.chip, in: Capsule())
                }
            } else {
                PillButton(title: "Share PDF", variant: .secondary, busy: loadingPdf) {
                    fetchPdf(documentId: review.document_reference_id)
                }
            }
        }
    }

    // MARK: State

    private var displayed: (review: AIService.ReviewResult, provenance: Provenance)? {
        if let fresh {
            return (fresh, freshProvenance)
        }
        if let latest {
            return (latest, Self.inferProvenance(latest))
        }
        return nil
    }

    /// Stored reviews carry no provenance field — infer from the server-set
    /// description, and only label AI when the description says so.
    /// Server strings (ai-service/app/health_review.py): deterministic runs
    /// store "Data summary (no AI) — last {N} days"; AI runs store
    /// "AI Health Review — last {N} days".
    private static func inferProvenance(_ review: AIService.ReviewResult) -> Provenance {
        let desc = (review.description ?? "").lowercased()
        // Deterministic markers MUST win before any AI check — the "AI"
        // inside "(no AI)" would otherwise put the indigo card + ✦ AI pill
        // on measured content (three-data-classes violation).
        if desc.contains("no ai") || desc.contains("data summary")
            || desc.contains("data-only") || desc.contains("data only")
            || desc.contains("deterministic") {
            return .deterministic
        }
        // "ai" as a whole word only — never a substring match.
        let words = desc.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        if words.contains("ai") {
            return .ai
        }
        return .unknown
    }

    // MARK: Actions

    @MainActor
    private func loadInitial() async {
        // Opportunistic cleanup: a crash or app kill while this screen was up
        // skips onDisappear, so a stale PDF from a previous visit — possibly
        // from before a sign-out, which does not remove it — may still be on
        // disk. Remove it before showing anything.
        Self.removePdfFile()

        // Stored latest: 404 means "none yet" — treat any failure as nil.
        latest = try? await model.ai.latestReview()

        do {
            let health = try await model.ai.health()
            aiConfigured = health.ai.configured
            if health.ai.configured {
                let providerName = health.ai.provider ?? "cloud provider"
                // Locality comes from /ai/settings; when the lookup fails,
                // over-disclose (treat as cloud) rather than hide a boundary.
                var isLocal = providerName.lowercased() == "ollama"
                if let settings = try? await model.ai.aiSettings(),
                   let info = settings.providers.first(where: { $0.name == health.ai.provider }) {
                    isLocal = info.is_local
                }
                cloudProviderName = isLocal ? nil : Self.displayName(providerName)
            } else {
                aiUnavailableNote = health.ai.reason
                    ?? "No AI provider configured — set one up in AI Settings. The data-only summary works without AI."
            }
        } catch {
            aiConfigured = false
            aiUnavailableNote = error.localizedDescription
        }
        initialLoaded = true
    }

    @MainActor
    private func generate(useAI: Bool) {
        errorMessage = nil
        if useAI {
            generatingAI = true
        } else {
            generatingData = true
        }
        Task {
            do {
                let review: AIService.ReviewResult
                if useAI {
                    review = try await model.ai.generateReview(windowDays: windowDays)
                } else {
                    review = try await model.ai.generateDataSummary(windowDays: windowDays)
                }
                fresh = review
                freshProvenance = useAI ? .ai : .deterministic
                pdfURL = nil // any previous PDF belongs to an older review
            } catch {
                errorMessage = error.localizedDescription
            }
            generatingAI = false
            generatingData = false
        }
    }

    // MARK: PDF share file

    /// Where the share PDF lives: App Support/HealMeDaily — the same directory
    /// AppModel.dataDirectory resolves for the outbox + core snapshot, so the
    /// clinical PDF shares their at-rest posture (iOS Data Protection
    /// complete) instead of sitting unprotected in tmp. NOTE the lifecycle
    /// contract: this file manages its own lifetime — deleted before every
    /// rewrite, on onDisappear, opportunistically in loadInitial, and by
    /// AppModel.signOut (which is why this static is not private: a
    /// signed-out device keeps no readable clinical files). Residual risk:
    /// if the app is killed while this screen is up, the (encrypted-at-rest)
    /// PDF persists until the screen is next opened or the user signs out.
    static var pdfFileURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent("HealMeDaily", isDirectory: true)
            .appendingPathComponent("health-review.pdf")
    }

    private static func removePdfFile() {
        try? FileManager.default.removeItem(at: pdfFileURL)
    }

    @MainActor
    private func fetchPdf(documentId: String) {
        errorMessage = nil
        loadingPdf = true
        Task {
            do {
                let data = try await model.ai.reviewPdf(documentId: documentId)
                let url = Self.pdfFileURL
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                Self.removePdfFile() // stale copy from an earlier review
                try data.write(to: url, options: [.atomic, .completeFileProtection])
                pdfURL = url
            } catch {
                errorMessage = error.localizedDescription
            }
            loadingPdf = false
        }
    }

    /// Provider names arrive lowercased from the service — show them the way
    /// the vendors write them.
    private static func displayName(_ provider: String) -> String {
        switch provider.lowercased() {
        case "anthropic": return "Anthropic"
        case "openai": return "OpenAI"
        case "gemini": return "Gemini"
        case "ollama": return "Ollama"
        default: return provider
        }
    }
}
