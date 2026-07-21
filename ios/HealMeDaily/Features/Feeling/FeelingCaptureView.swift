import SwiftUI
import HealMeDailyKit

/// FeelingCaptureView — the momentary "How am I feeling right now?" sheet
/// (FHIR-MAPPING §4). Reached from the Today card and from feeling-reminder
/// notification taps (AppModel.route "feeling").
///
/// Data rules honored here:
/// - Saves through the EXISTING quick-observation path (QuickLog.feelingNow →
///   model.saveQuickObservations): local mood/energy codes, client-event-UUID
///   identifiers, effectiveDateTime = now, meta.tag `feeling-now`. Offline it
///   queues via the outbox exactly like every other quick observation.
/// - Voice is on-device ONLY (SpeechDictation): if the locale has no local
///   model the UI says "unavailable" and falls back to typing — never a
///   silent switch to server recognition. Audio itself is never stored.
/// - The AI parse is optional and human-in-the-loop: parsed values pre-fill
///   the controls ✦ AI-labeled with the model's confidence, and NOTHING is
///   written until the user taps Save. THE TAG RULE: a value the user
///   manually edits after the parse loses its ✦ AI label and is saved
///   WITHOUT the `ai-parsed` meta.tag — the edited number is the user's own
///   assertion, not the AI's (see `aiFields`).
/// - Cloud routing for the parse is disclosed with the amber BoundaryRow
///   BEFORE the button; unknown routing over-discloses as cloud.
struct FeelingCaptureView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    private enum AiField: Hashable {
        case mood, energy
    }

    // Controls
    @State private var mood: Double = 5
    /// The slider shows a default position, but only an explicit user action
    /// (drag, or an AI prefill they can see) makes it saveable — a sheet
    /// opened and saved untouched must not fabricate a mood of 5.
    @State private var moodSet = false
    @State private var includeEnergy = false
    @State private var energy: Double = 5
    @State private var note = ""

    // Voice
    @State private var dictation = SpeechDictation()
    @State private var noteBeforeDictation = ""

    // AI parse
    @State private var aiSettings: AIService.AiSettings?
    @State private var parsing = false
    @State private var parse: AIService.FeelingParse?
    /// 503 detail from the ai-service — the "configure a provider" state
    /// (an explanation, never an error wall; same treatment as Assistant).
    @State private var parseUnconfigured: String?
    @State private var parseError: String?
    /// Controls still carrying the AI's parsed value UNEDITED. A manual edit
    /// removes the field here, which (a) drops the indigo ✦ AI styling and
    /// (b) saves that observation WITHOUT the `ai-parsed` meta.tag — the
    /// user's assertion, not the AI's (FHIR-MAPPING §4).
    @State private var aiFields: Set<AiField> = []

    @State private var saving = false
    @State private var errorMessage: String?
    /// Clinical capture time, frozen on the FIRST Save tap. A retry after a
    /// partial failure must rebuild the byte-identical payload so SyncEngine's
    /// frozen-payload retry reuses the already-stamped identifiers instead of
    /// re-creating observations that committed before the failure.
    @State private var pendingSaveTime: Date?

    private var trimmedNote: String {
        note.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Route of the 'feeling' AI feature. nil = unknown (settings fetch
    /// failed) — treated as CLOUD so the data boundary is over-disclosed,
    /// never hidden (same conservative reading as AssistantView).
    private var feelingRoute: AIService.AiRoute? {
        aiSettings?.routing["feeling"]
    }

    private var cloudRecipient: String {
        aiSettings?.cloud_provider ?? "cloud provider"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header

                    if let errorMessage {
                        ErrorBanner(message: errorMessage)
                    }

                    DsCard {
                        moodRow
                        Rectangle().fill(T.hairline).frame(height: 1)
                        energyRows
                    }

                    DsCard {
                        noteSection
                    }

                    if !trimmedNote.isEmpty {
                        parseCard
                    }

                    PillButton(title: "Save", busy: saving) { save() }
                        .disabled(!moodSet || saving)
                    if !moodSet {
                        Text("Set your mood to save — nothing is written until you do.")
                            .font(.ui(11))
                            .foregroundStyle(T.quaternary)
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(T.canvas)
            .navigationTitle("Right now")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            // Routing disclosure for the parse button (best-effort; a failed
            // fetch leaves nil ⇒ the BoundaryRow over-discloses as cloud).
            aiSettings = try? await model.ai.aiSettings()
        }
        .onChange(of: dictation.transcript) { _, transcript in
            guard !transcript.isEmpty else { return }
            // Live transcript streams into the note, after whatever was
            // already typed. The note stays fully editable afterwards.
            note = noteBeforeDictation.isEmpty
                ? transcript
                : "\(noteBeforeDictation) \(transcript)"
        }
        .onDisappear {
            dictation.stopDictation()
        }
    }

    // MARK: - Sections

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            PageHeader(
                title: "How am I feeling right now?",
                subtitle: "A ten-second spot check — it joins the same mood and energy trends as your daily check-in."
            )
            VaultChip()
        }
    }

    private var moodRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                FieldLabel(text: "Mood")
                if aiFields.contains(.mood) {
                    AIPill()
                }
                Spacer(minLength: 0)
                Text(moodSet ? "\(Int(mood))/10" : "—")
                    .font(.mono(13, weight: .medium))
                    .foregroundStyle(aiFields.contains(.mood) ? T.ai : T.ink)
            }
            Slider(value: moodBinding, in: 1 ... 10, step: 1)
                .tint(T.green)
                .accessibilityLabel("Mood, 1 to 10")
        }
    }

    @ViewBuilder
    private var energyRows: some View {
        Toggle(isOn: includeEnergyBinding) {
            HStack(spacing: 8) {
                FieldLabel(text: "Energy")
                if includeEnergy && aiFields.contains(.energy) {
                    AIPill()
                }
            }
        }
        .tint(T.green)
        if includeEnergy {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Spacer(minLength: 0)
                    Text("\(Int(energy))/10")
                        .font(.mono(13, weight: .medium))
                        .foregroundStyle(aiFields.contains(.energy) ? T.ai : T.ink)
                }
                Slider(value: energyBinding, in: 1 ... 10, step: 1)
                    .tint(T.green)
                    .accessibilityLabel("Energy, 1 to 10")
            }
        }
    }

    private var noteSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                FieldLabel(text: "Note (optional)")
                Spacer(minLength: 0)
                dictationButton
            }
            TextField(
                "",
                text: noteBinding,
                prompt: Text("Type, or dictate — e.g. \"bit low, headache since lunch\"").font(.ui(12.5)).foregroundStyle(T.quaternary),
                axis: .vertical
            )
            .lineLimit(2 ... 5)
            .textFieldStyle(BandFieldStyle())

            if dictation.state == .recording {
                HStack(spacing: 6) {
                    // Live-device class: green + pulsing dot — the mic is a
                    // live on-device feed while this shows.
                    StatusDot(color: T.green, size: 6, pulsing: true)
                    Text("Listening — transcribed on this iPhone, audio never leaves it")
                        .font(.mono(10, weight: .medium))
                        .foregroundStyle(T.green)
                }
            }
            switch dictation.state {
            case .unavailable:
                Text("On-device dictation isn't available for your language on this iPhone — type your note instead. (Voice is never sent to a server.)")
                    .font(.ui(11))
                    .foregroundStyle(T.watch)
            case .denied:
                Text("Microphone or speech permission is off for HealMeNow — enable both in iOS Settings, or type instead.")
                    .font(.ui(11))
                    .foregroundStyle(T.watch)
            case .idle, .recording:
                EmptyView()
            }
            if let dictationError = dictation.errorMessage {
                Text(dictationError)
                    .font(.ui(11))
                    .foregroundStyle(T.outOfRange)
            }
        }
    }

    private var dictationButton: some View {
        Button {
            toggleDictation()
        } label: {
            Image(systemName: dictation.state == .recording ? "stop.circle.fill" : "mic.fill")
                .font(.ui(16, weight: .medium))
                .foregroundStyle(dictation.state == .recording ? T.green : T.secondary)
                .frame(minWidth: 40, minHeight: 40)
                .background(T.band, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .contentShape(Rectangle())
        }
        .accessibilityLabel(dictation.state == .recording ? "Stop dictation" : "Dictate note")
    }

    /// The optional AI parse — indigo card, disclosure before the button,
    /// results labeled ✦ AI + confidence. Confirm-then-Save only.
    private var parseCard: some View {
        DsCard(ai: true) {
            HStack(spacing: 8) {
                Eyebrow(text: "Structure with AI", color: T.ai)
                Spacer(minLength: 0)
                AIPill()
            }

            // Cloud boundary BEFORE the send affordance; local routing shows
            // nothing amber (the transcript stays on the owner's machines).
            if feelingRoute != .local && feelingRoute != .off {
                BoundaryRow(recipient: cloudRecipient)
            }

            PillButton(title: "✦ Parse with AI", variant: .ai, busy: parsing) {
                runParse()
            }
            .disabled(parsing || trimmedNote.isEmpty)

            if let parse {
                parseResultRows(parse)
            }
            if let parseUnconfigured {
                // "Configure a provider" state — explanation, not an error wall.
                VStack(alignment: .leading, spacing: 4) {
                    Text(parseUnconfigured)
                        .font(.ui(12.5))
                        .foregroundStyle(T.secondary)
                    Text("Set up providers in AI settings (web app or Settings tab).")
                        .font(.ui(12))
                        .foregroundStyle(T.tertiary)
                }
            }
            if let parseError {
                ErrorBanner(message: parseError)
            }

            Text("Suggestions pre-fill the controls — adjust anything, then Save. An edited value is saved as yours, not the AI's.")
                .font(.ui(11))
                .foregroundStyle(T.quaternary)
        }
    }

    @ViewBuilder
    private func parseResultRows(_ parse: AIService.FeelingParse) -> some View {
        HStack(spacing: 8) {
            Text(parsedSummary(parse))
                .font(.mono(11, weight: .medium))
                .foregroundStyle(T.ai)
            Spacer(minLength: 0)
            Text("confidence \(parse.confidence)")
                .font(.mono(10))
                .foregroundStyle(T.ai)
        }
        if !parse.tags.isEmpty {
            // Tags are display context only (grounded verbatim in the
            // transcript server-side) — they are not saved as coded data.
            HStack(spacing: 6) {
                ForEach(parse.tags.prefix(5), id: \.self) { tag in
                    Chip(text: tag, ai: true)
                }
            }
        }
    }

    private func parsedSummary(_ parse: AIService.FeelingParse) -> String {
        var parts: [String] = []
        if let mood = parse.mood { parts.append("mood \(mood)/10") }
        if let energy = parse.energy { parts.append("energy \(energy)/10") }
        if parts.isEmpty { parts.append("no clear mood/energy stated") }
        return parts.joined(separator: " · ")
    }

    // MARK: - Bindings (manual edits drop the ✦ AI label — see aiFields)

    private var moodBinding: Binding<Double> {
        Binding(
            get: { mood },
            set: { newValue in
                mood = newValue
                moodSet = true
                // Manual edit ⇒ the user's assertion, not the AI's: the
                // ai-parsed tag is dropped for this value on save.
                aiFields.remove(.mood)
            }
        )
    }

    private var energyBinding: Binding<Double> {
        Binding(
            get: { energy },
            set: { newValue in
                energy = newValue
                aiFields.remove(.energy) // same rule as mood
            }
        )
    }

    private var includeEnergyBinding: Binding<Bool> {
        Binding(
            get: { includeEnergy },
            set: { includeEnergy = $0 }
        )
    }

    private var noteBinding: Binding<String> {
        Binding(
            get: { note },
            set: { newValue in
                note = newValue
                // Typing while a dictation is live would be overwritten by the
                // next partial — end the recording and keep both texts.
                if dictation.state == .recording {
                    dictation.stopDictation()
                }
                noteBeforeDictation = newValue
            }
        )
    }

    // MARK: - Actions

    private func toggleDictation() {
        if dictation.state == .recording {
            dictation.stopDictation()
            noteBeforeDictation = note
        } else {
            noteBeforeDictation = note
            Task { await dictation.startDictation() }
        }
    }

    private func runParse() {
        guard !parsing, !trimmedNote.isEmpty else { return }
        dictation.stopDictation()
        parsing = true
        parseError = nil
        parseUnconfigured = nil
        Task {
            do {
                let result = try await model.ai.parseFeeling(transcript: trimmedNote)
                parse = result
                // Pre-fill ✦ AI-labeled; the user confirms by tapping Save
                // (human-in-the-loop — nothing has been written yet).
                if let parsedMood = result.mood {
                    mood = Double(parsedMood)
                    moodSet = true
                    aiFields.insert(.mood)
                }
                if let parsedEnergy = result.energy {
                    includeEnergy = true
                    energy = Double(parsedEnergy)
                    aiFields.insert(.energy)
                }
                note = result.note
                noteBeforeDictation = result.note
            } catch let AIService.ServiceError.http(status, detail) where status == 503 {
                parseUnconfigured = detail // "configure a provider" state
            } catch {
                parseError = error.localizedDescription
            }
            parsing = false
        }
    }

    private func save() {
        guard moodSet, !saving else { return }
        saving = true
        errorMessage = nil
        // "Right now" = the first Save tap; a retry reuses it (see
        // pendingSaveTime) so the rebuilt payload converges, never duplicates.
        let when = pendingSaveTime ?? Date()
        pendingSaveTime = when
        Task {
            do {
                // meta.tag rule as implemented: feeling-now always; ai-parsed
                // per value, only while it still sits in aiFields (i.e. the
                // user confirmed it unedited).
                let observations = try QuickLog.feelingNow(
                    mood: Int(mood),
                    energy: includeEnergy ? Int(energy) : nil,
                    note: note,
                    moodAiParsed: aiFields.contains(.mood),
                    energyAiParsed: includeEnergy && aiFields.contains(.energy),
                    when: when
                )
                // Offline-tolerant: queues via the outbox exactly like every
                // other quick observation; Today's sync strip shows pending.
                _ = try await model.saveQuickObservations(observations)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            saving = false
        }
    }
}
