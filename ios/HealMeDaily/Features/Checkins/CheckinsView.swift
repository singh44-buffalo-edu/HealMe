import SwiftUI
import HealMeDailyKit

/// CheckinsView — the cadence check-in hub + a native questionnaire renderer,
/// the iOS port of the web `CheckinPage` (frontend/src/pages/CheckinPage.tsx).
///
/// Cadence engine (FHIR-MAPPING §2): every active Questionnaire tagged with
/// the questionnaire-cadence extension is a check-in; `loadCheckins()` derives
/// the current period identifier and looks up whether a QuestionnaireResponse
/// already exists for it. "DUE" simply means: no response for this period yet
/// — dueness is derived, never stored. Resubmitting inside the same period
/// UPDATES the existing response (same identifier), never duplicates
/// (`submitCheckin` is idempotent by construction).
///
/// The web page delegates rendering to @medplum/react's QuestionnaireForm; on
/// iOS the form is rendered natively from `questionnaire.item` — groups,
/// display, integer (0–10 slider — covers the seeded bank), decimal, string /
/// text, boolean, choice and date items.
///
/// Downstream: a Subscription-triggered Bot fans selected answers out to
/// Observations. This screen never writes Observations itself —
/// QuestionnaireResponse is the source of truth (FHIR-MAPPING §4).
struct CheckinsView: View {
    @Environment(AppModel.self) private var model

    @State private var checkins: [CheckinDef]?
    @State private var selected: CheckinDef?
    @State private var editing = false
    @State private var error: String?
    @State private var note: String?
    @State private var saving = false

    // Form answers keyed by linkId — one dictionary per FHIR item type so
    // each control binds to its natural Swift type. Submit reads these back
    // into the correct value[x] slot per item type.
    @State private var intAnswers: [String: Int] = [:]
    @State private var decimalAnswers: [String: String] = [:]
    @State private var textAnswers: [String: String] = [:]
    @State private var boolAnswers: [String: Bool] = [:]
    @State private var choiceAnswers: [String: String] = [:]
    @State private var dateAnswers: [String: Date] = [:]
    // linkIds the user actually answered (control interacted with, or
    // prefilled from a stored response). Sliders/toggles/date pickers show a
    // default position, but only touched linkIds are ever SUBMITTED — a
    // half-filled check-in must not fabricate answers the user never gave.
    @State private var touched: Set<String> = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    PageHeader(title: "Check-ins", subtitle: subtitle)
                    VaultChip()
                }

                if let error {
                    ErrorBanner(message: error)
                }
                if let note {
                    savedNote(note)
                }

                if let checkins {
                    if checkins.isEmpty {
                        EmptyNote(text: "No check-in questionnaires found — run make seed on the server.")
                    } else {
                        tileGrid(checkins)
                        if let def = currentDef(in: checkins) {
                            if def.existing != nil && !editing {
                                answersCard(def)
                            } else {
                                formCard(def)
                            }
                        }
                    }
                } else if error == nil {
                    ProgressView()
                        .tint(T.green)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                } else {
                    PillButton(title: "Try again", variant: .secondary) {
                        Task { await reload(selectFirstDue: true) }
                    }
                }
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(T.canvas)
        .navigationTitle("Check-ins")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // First appearance only — .task re-runs on every tab switch
            // back, and reloading then would wipe in-progress form state.
            if checkins == nil {
                await reload(selectFirstDue: true)
            }
        }
        .refreshable { await reload() }
    }

    // MARK: - Derived

    private var subtitle: String {
        guard let checkins else { return "daily / weekly / monthly" }
        let due = checkins.filter(\.isDue).count
        return "\(checkins.count) check-ins · \(due) due · daily / weekly / monthly"
    }

    /// Resolve the selection against the freshest list (defs are value
    /// copies — after a reload the stored `selected` may carry a stale
    /// `existing`, so always re-find by questionnaire url).
    private func currentDef(in checkins: [CheckinDef]) -> CheckinDef? {
        guard let selected else { return checkins.first }
        return checkins.first { $0.questionnaire.url == selected.questionnaire.url } ?? checkins.first
    }

    // MARK: - Loading

    private func reload(selectFirstDue: Bool = false) async {
        do {
            let defs = try await model.record.loadCheckins()
            checkins = defs
            error = nil
            if let current = selected {
                selected = defs.first { $0.questionnaire.url == current.questionnaire.url } ?? defs.first
            } else if selectFirstDue {
                selected = defs.first { $0.isDue } ?? defs.first
            }
            // A freshly-selected DUE check-in goes straight to a blank form.
            if let def = selected, def.existing == nil, !editing {
                startForm(def, prefill: false)
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func select(_ def: CheckinDef) {
        let alreadySelected = def.questionnaire.url == selected?.questionnaire.url
        selected = def
        editing = false
        note = nil
        // Re-tapping the current tile must not wipe half-typed answers.
        if def.existing == nil, !alreadySelected {
            startForm(def, prefill: false)
        }
    }

    // MARK: - Tiles

    private func tileGrid(_ checkins: [CheckinDef]) -> some View {
        LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible())],
            spacing: 12
        ) {
            ForEach(Array(checkins.enumerated()), id: \.offset) { _, def in
                CheckinTile(
                    def: def,
                    selected: def.questionnaire.url == currentDef(in: checkins)?.questionnaire.url
                ) {
                    select(def)
                }
            }
        }
    }

    // MARK: - Read-back card (already done this period)

    private func answersCard(_ def: CheckinDef) -> some View {
        DsCard {
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                StatusDot(color: T.inRange, size: 7)
                Text("\(def.questionnaire.title ?? "Check-in") — done for this \(def.cadence.label.lowercased()) period")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(T.ink)
            }
            if let authored = def.existing?.authored {
                Text("Submitted \(Fmt.when(authored))")
                    .font(.mono(10.5))
                    .foregroundStyle(T.tertiary)
                    .padding(.leading, 16)
            }

            Eyebrow(text: "Answers")
            let rows = flattenResponseItems(def.existing?.item)
            if rows.isEmpty {
                EmptyNote(text: "No answers recorded.")
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        if index > 0 {
                            Rectangle().fill(T.band).frame(height: 1)
                        }
                        answerRow(row)
                    }
                }
            }

            PillButton(title: "Edit answers", variant: .secondary) {
                note = nil
                startForm(def, prefill: true)
                editing = true
            }
        }
    }

    private func answerRow(_ item: QuestionnaireResponseItem) -> some View {
        let answer = item.answer?.first
        let numeric = answer?.valueInteger != nil || answer?.valueDecimal != nil
        return HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text(item.linkId ?? "")
                .font(.mono(10.5))
                .foregroundStyle(T.quaternary)
                .frame(width: 110, alignment: .leading)
            Text(answer?.display ?? "—")
                .font(numeric ? .mono(13, weight: .medium) : .system(size: 13))
                .foregroundStyle(T.ink)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 9)
    }

    /// Flatten a stored response (answers may be nested under groups when
    /// they were submitted from the web form) into displayable rows.
    private func flattenResponseItems(_ items: [QuestionnaireResponseItem]?) -> [QuestionnaireResponseItem] {
        var out: [QuestionnaireResponseItem] = []
        for item in items ?? [] {
            if let answers = item.answer, !answers.isEmpty, answers.first?.display != nil {
                out.append(item)
            }
            out.append(contentsOf: flattenResponseItems(item.item))
        }
        return out
    }

    // MARK: - Form card

    private func formCard(_ def: CheckinDef) -> some View {
        DsCard {
            HStack {
                Eyebrow(text: "\(def.cadence.label) check-in")
                Spacer()
                CheckinStateTag(due: def.isDue)
            }
            Rectangle().fill(T.hairline).frame(height: 1)

            childViews(def.questionnaire.item)

            PillButton(
                title: def.existing == nil ? "Submit check-in" : "Save changes",
                variant: .primary,
                busy: saving
            ) {
                submit(def)
            }
            Text("Resubmitting in the same \(def.cadence.label.lowercased()) period updates the same response.")
                .font(.system(size: 11))
                .foregroundStyle(T.quaternary)
        }
    }

    /// Recursive renderer over `questionnaire.item`. Explicit AnyView return
    /// types keep the mutual recursion (group → children → group…) trivially
    /// well-typed.
    private func childViews(_ items: [QuestionnaireItem]?) -> AnyView {
        AnyView(
            ForEach(Array((items ?? []).enumerated()), id: \.offset) { _, item in
                itemView(item)
            }
        )
    }

    private func itemView(_ item: QuestionnaireItem) -> AnyView {
        let control = controlView(item)
        // Question items can themselves nest children (rare outside groups).
        if item.type != "group", let children = item.item, !children.isEmpty {
            return AnyView(
                VStack(alignment: .leading, spacing: 12) {
                    control
                    childViews(children)
                }
            )
        }
        return control
    }

    private func controlView(_ item: QuestionnaireItem) -> AnyView {
        switch item.type {
        case "group":
            return AnyView(
                VStack(alignment: .leading, spacing: 12) {
                    if let text = item.text, !text.isEmpty {
                        Eyebrow(text: text)
                    }
                    childViews(item.item)
                }
                .padding(.top, 4)
            )

        case "display":
            return AnyView(
                Text(item.text ?? "")
                    .font(.system(size: 12.5))
                    .foregroundStyle(T.secondary)
            )

        case "integer":
            guard let linkId = item.linkId else { return AnyView(EmptyView()) }
            return AnyView(
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        questionLabel(item)
                        Spacer()
                        Text("\(intAnswers[linkId] ?? 5)")
                            .font(.mono(15, weight: .semibold))
                            .foregroundStyle(T.ink)
                    }
                    // Any integer item renders as a 0–10 scale — covers the
                    // seeded question bank.
                    Slider(value: intBinding(linkId), in: 0 ... 10, step: 1)
                        .tint(T.green)
                }
            )

        case "decimal":
            guard let linkId = item.linkId else { return AnyView(EmptyView()) }
            return AnyView(
                VStack(alignment: .leading, spacing: 8) {
                    questionLabel(item)
                    TextField("", text: decimalBinding(linkId))
                        .textFieldStyle(BandFieldStyle())
                        .keyboardType(.decimalPad)
                        .font(.mono(14))
                }
            )

        case "string":
            guard let linkId = item.linkId else { return AnyView(EmptyView()) }
            return AnyView(
                VStack(alignment: .leading, spacing: 8) {
                    questionLabel(item)
                    TextField("", text: stringBinding(linkId))
                        .textFieldStyle(BandFieldStyle())
                }
            )

        case "text":
            guard let linkId = item.linkId else { return AnyView(EmptyView()) }
            return AnyView(
                VStack(alignment: .leading, spacing: 8) {
                    questionLabel(item)
                    TextField("", text: stringBinding(linkId), axis: .vertical)
                        .lineLimit(3 ... 6)
                        .textFieldStyle(BandFieldStyle())
                }
            )

        case "boolean":
            guard let linkId = item.linkId else { return AnyView(EmptyView()) }
            return AnyView(
                Toggle(isOn: boolBinding(linkId)) {
                    questionLabel(item)
                }
                .tint(T.green)
            )

        case "choice":
            guard let linkId = item.linkId else { return AnyView(EmptyView()) }
            let options = (item.answerOption ?? []).map(optionLabel).filter { !$0.isEmpty }
            return AnyView(
                HStack {
                    questionLabel(item)
                    Spacer()
                    Picker("", selection: choiceBinding(linkId)) {
                        Text("Select…").tag("")
                        ForEach(options, id: \.self) { option in
                            Text(option).tag(option)
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(T.ink)
                }
            )

        case "date":
            guard let linkId = item.linkId else { return AnyView(EmptyView()) }
            return AnyView(
                DatePicker(
                    selection: dateBinding(linkId),
                    in: ...Date(),
                    displayedComponents: .date
                ) {
                    questionLabel(item)
                }
                .tint(T.green)
            )

        default:
            return AnyView(EmptyView())
        }
    }

    /// Question text is prose — system font, never mono (design rule §2).
    private func questionLabel(_ item: QuestionnaireItem) -> some View {
        Text(item.text ?? item.linkId ?? "")
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(T.ink)
    }

    // MARK: - Bindings

    private func intBinding(_ linkId: String) -> Binding<Double> {
        Binding(
            get: { Double(intAnswers[linkId] ?? 5) },
            set: {
                touched.insert(linkId)
                intAnswers[linkId] = Int($0.rounded())
            }
        )
    }

    private func decimalBinding(_ linkId: String) -> Binding<String> {
        Binding(
            get: { decimalAnswers[linkId] ?? "" },
            set: {
                touched.insert(linkId)
                decimalAnswers[linkId] = $0
            }
        )
    }

    private func stringBinding(_ linkId: String) -> Binding<String> {
        Binding(
            get: { textAnswers[linkId] ?? "" },
            set: {
                touched.insert(linkId)
                textAnswers[linkId] = $0
            }
        )
    }

    private func boolBinding(_ linkId: String) -> Binding<Bool> {
        Binding(
            get: { boolAnswers[linkId] ?? false },
            set: {
                touched.insert(linkId)
                boolAnswers[linkId] = $0
            }
        )
    }

    private func choiceBinding(_ linkId: String) -> Binding<String> {
        Binding(
            get: { choiceAnswers[linkId] ?? "" },
            set: {
                touched.insert(linkId)
                choiceAnswers[linkId] = $0
            }
        )
    }

    private func dateBinding(_ linkId: String) -> Binding<Date> {
        Binding(
            get: { dateAnswers[linkId] ?? Date() },
            set: {
                touched.insert(linkId)
                dateAnswers[linkId] = $0
            }
        )
    }

    private func optionLabel(_ option: QuestionnaireAnswerOption) -> String {
        option.valueString
            ?? option.valueCoding?.display
            ?? option.valueCoding?.code
            ?? option.valueInteger.map(String.init)
            ?? ""
    }

    // MARK: - Form state

    /// Reset the answer dictionaries for a fresh form; when `prefill`, seed
    /// them from the stored response so "Edit answers" starts from what was
    /// submitted instead of a blank form (a partial re-entry must not
    /// silently drop the untouched answers from the record).
    private func startForm(_ def: CheckinDef, prefill: Bool) {
        intAnswers = [:]
        decimalAnswers = [:]
        textAnswers = [:]
        boolAnswers = [:]
        choiceAnswers = [:]
        dateAnswers = [:]
        touched = []
        var existing: [String: QuestionnaireResponseAnswer] = [:]
        if prefill {
            for row in flattenResponseItems(def.existing?.item) {
                if let linkId = row.linkId, let answer = row.answer?.first {
                    existing[linkId] = answer
                }
            }
            // Stored answers count as answered — an edit that only changes
            // one field must re-save the rest, not drop them.
            touched = Set(existing.keys)
        }
        seedDefaults(def.questionnaire.item ?? [], existing: existing)
    }

    private func seedDefaults(_ items: [QuestionnaireItem], existing: [String: QuestionnaireResponseAnswer]) {
        for item in items {
            if item.type == "group" {
                seedDefaults(item.item ?? [], existing: existing)
                continue
            }
            if let linkId = item.linkId {
                let answer = existing[linkId]
                switch item.type {
                case "integer":
                    intAnswers[linkId] = answer?.valueInteger ?? 5
                case "decimal":
                    // Full-fidelity round-trip (String(7.25) = "7.25") so an
                    // untouched prefilled value re-saves exactly as stored.
                    if let value = answer?.valueDecimal {
                        decimalAnswers[linkId] = value == value.rounded() ? String(Int(value)) : String(value)
                    } else {
                        decimalAnswers[linkId] = ""
                    }
                case "string", "text":
                    textAnswers[linkId] = answer?.valueString ?? ""
                case "boolean":
                    boolAnswers[linkId] = answer?.valueBoolean ?? false
                case "choice":
                    choiceAnswers[linkId] = answer?.valueCoding?.display
                        ?? answer?.valueCoding?.code
                        ?? answer?.valueString
                        ?? ""
                case "date":
                    if let value = answer?.valueDate, let date = Fmt.localDay(value) {
                        dateAnswers[linkId] = date
                    } else {
                        dateAnswers[linkId] = Date()
                    }
                default:
                    break
                }
            }
            if item.type != "group", let children = item.item {
                seedDefaults(children, existing: existing)
            }
        }
    }

    // MARK: - Submit

    /// Build response items ONLY for answered questions, each answer in the
    /// value[x] slot matching its item type. "Answered" means touched — the
    /// user interacted with the control (or it was prefilled from a stored
    /// response); text, decimal and choice items additionally count only
    /// when non-empty / parseable / selected. Untouched controls display
    /// defaults but never submit them (matches the web form's behavior).
    private func buildItems(_ def: CheckinDef) -> [QuestionnaireResponseItem] {
        var out: [QuestionnaireResponseItem] = []
        func walk(_ items: [QuestionnaireItem]) {
            for item in items {
                if item.type == "group" {
                    walk(item.item ?? [])
                    continue
                }
                if let linkId = item.linkId, let answer = builtAnswer(item, linkId: linkId) {
                    out.append(QuestionnaireResponseItem(linkId: linkId, text: item.text, answer: [answer]))
                }
                if item.type != "group", let children = item.item {
                    walk(children)
                }
            }
        }
        walk(def.questionnaire.item ?? [])
        return out
    }

    private func builtAnswer(_ item: QuestionnaireItem, linkId: String) -> QuestionnaireResponseAnswer? {
        guard touched.contains(linkId) else { return nil }
        switch item.type {
        case "integer":
            guard let value = intAnswers[linkId] else { return nil }
            return QuestionnaireResponseAnswer(valueInteger: value)
        case "decimal":
            let text = (decimalAnswers[linkId] ?? "").trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty, let value = Double(text) else { return nil }
            return QuestionnaireResponseAnswer(valueDecimal: value)
        case "string", "text":
            let text = (textAnswers[linkId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return QuestionnaireResponseAnswer(valueString: text)
        case "boolean":
            guard let value = boolAnswers[linkId] else { return nil }
            return QuestionnaireResponseAnswer(valueBoolean: value)
        case "choice":
            guard let label = choiceAnswers[linkId], !label.isEmpty,
                  let option = item.answerOption?.first(where: { optionLabel($0) == label })
            else { return nil }
            if let coding = option.valueCoding {
                return QuestionnaireResponseAnswer(valueCoding: coding)
            }
            if let string = option.valueString {
                return QuestionnaireResponseAnswer(valueString: string)
            }
            if let integer = option.valueInteger {
                return QuestionnaireResponseAnswer(valueInteger: integer)
            }
            return nil
        case "date":
            guard let date = dateAnswers[linkId] else { return nil }
            return QuestionnaireResponseAnswer(valueDate: DoseEngine.localDateString(date))
        default:
            return nil
        }
    }

    private func submit(_ def: CheckinDef) {
        saving = true
        error = nil
        note = nil
        Task {
            do {
                let items = buildItems(def)
                let queued = try await model.submitCheckin(def, items: items)
                editing = false
                if queued {
                    // Offline: the response is queued on-device; skip the
                    // reload (it would fail) and say what actually happened.
                    note = "Saved on this device — syncs when your server is reachable."
                } else {
                    note = "Saved — resubmits in the same period update the same response."
                    await reload()
                }
            } catch {
                self.error = error.localizedDescription
            }
            saving = false
        }
    }

    // MARK: - Small pieces

    private func savedNote(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            StatusDot(color: T.inRange, size: 6)
            Text(text)
                .font(.system(size: 12.5))
                .foregroundStyle(T.ink)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.greenTint, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

// MARK: - Tile

/// Selector tile — DS tile language (1px chip border, r16; selected = green
/// border + green-tinted shadow). Tiles are selector controls, so they carry
/// a border deliberately, unlike DsCard.
private struct CheckinTile: View {
    let def: CheckinDef
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                Text(def.questionnaire.title ?? "Check-in")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(T.ink)
                    .multilineTextAlignment(.leading)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack {
                    Text(def.cadence.label.lowercased())
                        .font(.mono(10))
                        .foregroundStyle(T.tertiary)
                    Spacer()
                    CheckinStateTag(due: def.isDue)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 74, alignment: .topLeading)
            .background(T.card)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(selected ? T.green : T.chip, lineWidth: 1)
            )
            .shadow(color: selected ? T.green.opacity(0.10) : .clear, radius: 8, y: 4)
        }
        .buttonStyle(.plain)
    }
}

/// Mono state word + status dot: DUE (watch amber) / DONE (in-range green) —
/// status color on the value/dot only, never flooding the tile.
private struct CheckinStateTag: View {
    let due: Bool

    var body: some View {
        HStack(spacing: 6) {
            StatusDot(color: due ? T.watch : T.inRange, size: 6)
            Text(due ? "DUE" : "DONE")
                .font(.mono(10, weight: .medium))
                .kerning(0.6)
                .foregroundStyle(due ? T.watch : T.inRange)
        }
    }
}
