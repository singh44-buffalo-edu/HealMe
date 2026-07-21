import SwiftUI
import HealMeDailyKit

/// Clinical profile — the read-only record view of enduring problems
/// (Condition), allergies & intolerances (AllergyIntolerance) and
/// immunizations (Immunization). These resources enter the record via
/// document ingestion or the web app; this screen only reflects them.
///
/// Medical-safety framing (non-negotiable):
/// - Everything is displayed VERBATIM from the source resource — status
///   codes, criticality, severities. The app never ranks, never assesses,
///   never invents a threshold or verdict (SR-3).
/// - The only coloring is an echo of source-stated fields: an allergy the
///   SOURCE marked criticality "high" reads in the out-of-range hue; a
///   completed immunization reads green. Color sits on the value tag only,
///   never floods a card.
/// - No AI content on this screen — no indigo anywhere.
struct ProfileView: View {
    @Environment(AppModel.self) private var model

    // MARK: State

    /// nil until the loads on appear resolve — the loading gate.
    @State private var conditions: [Condition]?
    @State private var allergies: [AllergyIntolerance] = []
    @State private var immunizations: [Immunization] = []
    @State private var loadError: String?
    @State private var didLoad = false

    // MARK: Body

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    PageHeader(
                        title: "Clinical profile",
                        subtitle: "Problems, allergies and immunizations exactly as recorded — they enter the record via document ingestion or the web app."
                    )
                    VaultChip()
                }

                if let loadError {
                    ErrorBanner(message: loadError)
                }

                if conditions == nil {
                    if loadError == nil {
                        HStack {
                            Spacer()
                            ProgressView().tint(T.green)
                            Spacer()
                        }
                        .padding(.vertical, 48)
                    }
                } else {
                    section("Problem list") { conditionsCard }
                    section("Allergies & intolerances") { allergiesCard }
                    section("Immunizations") { immunizationsCard }

                    Text("Read-only — this screen reflects the record; nothing here is interpreted.")
                        .font(.mono(10.5))
                        .foregroundStyle(T.quaternary)
                }
            }
            .padding(16)
        }
        .background(T.canvas)
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard !didLoad else { return }
            didLoad = true
            await load()
        }
        .refreshable { await load() }
    }

    // MARK: Sections

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: title)
            content()
        }
    }

    private var conditionsCard: some View {
        DsCard {
            let items = conditions ?? []
            if items.isEmpty {
                EmptyNote(text: "No conditions recorded — enduring problems enter the record via document ingestion or the web app.")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.offset) { index, condition in
                        if index > 0 {
                            Rectangle().fill(T.hairline).frame(height: 1)
                        }
                        ConditionRow(condition: condition)
                    }
                }
            }
        }
    }

    private var allergiesCard: some View {
        DsCard {
            if allergies.isEmpty {
                EmptyNote(text: "No allergies or intolerances recorded — they enter the record via document ingestion or the web app.")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(allergies.enumerated()), id: \.offset) { index, allergy in
                        if index > 0 {
                            Rectangle().fill(T.hairline).frame(height: 1)
                        }
                        AllergyRow(allergy: allergy)
                    }
                }
            }
        }
    }

    private var immunizationsCard: some View {
        DsCard {
            if immunizations.isEmpty {
                EmptyNote(text: "No immunizations recorded — they enter the record via document ingestion or the web app.")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(immunizations.enumerated()), id: \.offset) { index, immunization in
                        if index > 0 {
                            Rectangle().fill(T.hairline).frame(height: 1)
                        }
                        ImmunizationRow(immunization: immunization)
                    }
                }
            }
        }
    }

    // MARK: Load

    /// Three bounded reads; display order is derived client-side (newest
    /// first by the resource's own clinical date, recorded date as fallback).
    private func load() async {
        do {
            let loadedConditions = try await model.record.loadConditions()
            let loadedAllergies = try await model.record.loadAllergies()
            let loadedImmunizations = try await model.record.loadImmunizations()
            guard !Task.isCancelled else {
                didLoad = false // navigated away mid-load — retry on return
                return
            }
            // ISO-8601 date strings compare correctly as plain strings, so
            // the sorts stay on the wire values — no Date round-trip.
            conditions = loadedConditions.sorted {
                ($0.onsetDateTime ?? $0.recordedDate ?? "") > ($1.onsetDateTime ?? $1.recordedDate ?? "")
            }
            allergies = loadedAllergies.sorted {
                ($0.recordedDate ?? "") > ($1.recordedDate ?? "")
            }
            immunizations = loadedImmunizations.sorted {
                ($0.occurrenceDateTime ?? "") > ($1.occurrenceDateTime ?? "")
            }
            loadError = nil
        } catch {
            // A cancelled .task (tab switch mid-load) is not a failure — and
            // pinning didLoad would block every future retry.
            guard !Task.isCancelled else {
                didLoad = false
                return
            }
            loadError = error.localizedDescription
        }
    }
}

// MARK: - Rows

/// One problem-list entry: name, verbatim clinical status, onset/recorded date.
private struct ConditionRow: View {
    let condition: Condition

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(condition.code?.text ?? condition.code?.coding?.first?.display ?? "(unnamed)")
                    .font(.ui(14.5, weight: .semibold))
                    .foregroundStyle(T.ink)
                if let dateLine {
                    Text(dateLine)
                        .font(.mono(10.5))
                        .foregroundStyle(T.tertiary)
                }
            }
            Spacer(minLength: 8)
            // Verbatim source status ("active" / "resolved" / …) — active
            // reads in ink, everything else recedes to tertiary. Echo only,
            // never an assessment.
            if let status = condition.clinicalStatus?.coding?.first?.code {
                MonoTag(text: status, color: status == "active" ? T.ink : T.tertiary)
            }
        }
        .padding(.vertical, 9)
    }

    /// "since <onset>" when the source states an onset; otherwise the date
    /// the problem was recorded. Dates stay verbatim (day precision).
    private var dateLine: String? {
        if let onset = condition.onsetDateTime {
            return "since \(onset.prefix(10))"
        }
        if let recorded = condition.recordedDate {
            return "recorded \(recorded.prefix(10))"
        }
        return nil
    }
}

/// One allergy/intolerance entry: name, verbatim criticality, reactions.
private struct AllergyRow: View {
    let allergy: AllergyIntolerance

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(allergy.code?.text ?? allergy.code?.coding?.first?.display ?? "(unnamed)")
                    .font(.ui(14.5, weight: .semibold))
                    .foregroundStyle(T.ink)
                Spacer(minLength: 8)
                // Source-stated criticality, verbatim ("low" / "high" /
                // "unable-to-assess"). Only a source "high" gets the
                // out-of-range hue — the app never grades it itself.
                if let criticality = allergy.criticality {
                    MonoTag(text: criticality, color: criticality == "high" ? T.outOfRange : T.secondary)
                }
            }
            ForEach(Array(reactionLines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.ui(12))
                    .foregroundStyle(T.secondary)
            }
        }
        .padding(.vertical, 9)
    }

    /// "hives, wheezing (severe)" — manifestation texts joined, the source's
    /// severity echoed in parentheses when present.
    private var reactionLines: [String] {
        (allergy.reaction ?? []).compactMap { reaction in
            let manifestations = (reaction.manifestation ?? [])
                .compactMap { $0.text ?? $0.coding?.first?.display }
            guard !manifestations.isEmpty else { return nil }
            let joined = manifestations.joined(separator: ", ")
            return reaction.severity.map { "\(joined) (\($0))" } ?? joined
        }
    }
}

/// One immunization entry: vaccine, occurrence date, verbatim status.
private struct ImmunizationRow: View {
    let immunization: Immunization

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(immunization.vaccineCode?.text ?? immunization.vaccineCode?.coding?.first?.display ?? "(unnamed)")
                    .font(.ui(14.5, weight: .semibold))
                    .foregroundStyle(T.ink)
                if let occurred = immunization.occurrenceDateTime {
                    Text(occurred.prefix(10))
                        .font(.mono(10.5))
                        .foregroundStyle(T.tertiary)
                }
            }
            Spacer(minLength: 8)
            // Verbatim FHIR status — "completed" reads green, anything else
            // ("not-done", "entered-in-error") stays quiet secondary.
            if let status = immunization.status {
                MonoTag(text: status, color: status == "completed" ? T.green : T.secondary)
            }
        }
        .padding(.vertical, 9)
    }
}

// MARK: - Local primitives

/// Chip-shaped mono tag with a caller-chosen text color — private because
/// the shared `Chip` fixes its foreground and this screen needs the color to
/// echo source-stated fields (same replicate-privately pattern as
/// AdherenceView's window picker).
private struct MonoTag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.mono(10))
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(T.chip, in: Capsule())
    }
}
