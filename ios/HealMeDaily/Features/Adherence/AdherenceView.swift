import SwiftUI
import HealMeDailyKit

/// Adherence dashboard — pure math over the shared med/dose-log caches
/// (`model.meds` / `model.admins`) via DoseEngine; this screen fetches
/// nothing of its own and writes nothing, ever.
///
/// Medical-safety framing (owner-approved, non-negotiable):
/// - The percentage counts LOGGED doses only. Unlogged slots (silence) are
///   shown as their own calendar state and are never counted as missed.
/// - Per-med bars are always green fill — they report a ratio, they never
///   judge it (no thresholds, no amber/red verdicts).
/// - Life-critical sorting/red dot is display prominence only.
struct AdherenceView: View {
    @Environment(AppModel.self) private var model
    @State private var days = 30

    private static let windowOptions = [7, 30, 90]

    var body: some View {
        Group {
            if !model.coreLoaded {
                loadingState
            } else {
                dashboard
            }
        }
        .navigationTitle("Adherence")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: Loading guard

    private var loadingState: some View {
        VStack(spacing: 16) {
            if let error = model.coreLoadError {
                ErrorBanner(message: error)
                PillButton(title: "Retry", variant: .secondary) {
                    Task { await model.refreshCore() }
                }
            } else {
                ProgressView()
                    .tint(T.green)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T.canvas)
        .task { await model.refreshCore() }
    }

    // MARK: Dashboard

    private var dashboard: some View {
        // All derived, every render, from the same slot model Today/Meds use —
        // the percentage, calendar, streak and per-med bars always agree.
        let summaries = DoseEngine.summarizeDays(
            meds: model.meds, admins: model.admins, days: days, today: Date()
        )
        let streakWindow = DoseEngine.summarizeDays(
            meds: model.meds, admins: model.admins, days: 90, today: Date()
        )
        let stats = DoseEngine.adherenceStats(
            meds: model.meds, admins: model.admins,
            daySummaries: summaries, streakDays: streakWindow
        )

        return ScrollView {
            VStack(spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    PageHeader(title: "Adherence", subtitle: "What you logged — nothing inferred.")
                    VaultChip()
                }

                if let error = model.coreLoadError {
                    ErrorBanner(message: error)
                }

                windowPicker
                heroCard(stats)
                heatCard(summaries)
                perMedCard(stats)

                Text("Unlogged doses are silence, not misses — only your explicit taps are counted.")
                    .font(.mono(10))
                    .foregroundStyle(T.quaternary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(16)
        }
        .background(T.canvas)
        .refreshable { await model.refreshCore() }
    }

    // MARK: Window picker

    private var windowPicker: some View {
        HStack(spacing: 4) {
            ForEach(Self.windowOptions, id: \.self) { n in
                Button {
                    days = n
                } label: {
                    Text("\(n) days")
                        .font(.mono(12, weight: days == n ? .semibold : .regular))
                        .foregroundStyle(days == n ? T.ink : T.tertiary)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 36)
                        .background {
                            if days == n {
                                Capsule().fill(T.card)
                                    .shadow(color: Color.black.opacity(0.06), radius: 3, y: 1)
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(T.band, in: Capsule())
    }

    // MARK: Hero

    private func heroCard(_ stats: AdherenceStats) -> some View {
        DsCard {
            Eyebrow(text: "Adherence · last \(days) days")

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(stats.pct.map { "\($0)%" } ?? "—")
                    .font(.mono(44, weight: .semibold))
                    .foregroundStyle(T.ink)
                Text("of logged doses taken")
                    .font(.system(size: 12.5))
                    .foregroundStyle(T.secondary)
            }

            HStack(spacing: 8) {
                statChip("\(stats.taken) taken")
                statChip("\(stats.notDone) skipped/missed")
                statChip("\(stats.streak)-day streak", tinted: stats.streak > 0)
            }

            Text("Counts logged doses only — unlogged doses appear as their own state below and are never counted as missed.")
                .font(.system(size: 11))
                .foregroundStyle(T.quaternary)
        }
    }

    private func statChip(_ text: String, tinted: Bool = false) -> some View {
        Text(text)
            .font(.mono(11, weight: .medium))
            .foregroundStyle(tinted ? T.green : T.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(tinted ? T.greenTint : T.chip, in: Capsule())
    }

    // MARK: Heat calendar

    private func heatCard(_ summaries: [DaySummary]) -> some View {
        DsCard {
            Eyebrow(text: "Day by day")
            LazyVGrid(
                columns: Array(
                    repeating: GridItem(.flexible(minimum: 14, maximum: 26), spacing: 5),
                    count: 7
                ),
                spacing: 5
            ) {
                // summarizeDays is oldest-first already — render in order.
                ForEach(summaries, id: \.date) { day in
                    dayCell(day)
                }
            }
            legend
        }
    }

    private func dayCell(_ day: DaySummary) -> some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(cellColor(day.status))
            .overlay {
                if day.status == .noDoses {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(T.hairline, lineWidth: 1)
                }
            }
            .aspectRatio(1, contentMode: .fit)
    }

    private func cellColor(_ status: DayStatus) -> Color {
        switch status {
        case .allTaken: return T.heatTaken
        case .partial: return T.heatLate
        case .noneTaken: return T.heatMissed
        case .unlogged: return T.band
        case .noDoses: return .clear
        }
    }

    private var legend: some View {
        HStack(spacing: 10) {
            legendItem(color: T.heatTaken, label: "all taken")
            legendItem(color: T.heatLate, label: "partial")
            legendItem(color: T.heatMissed, label: "skipped/missed")
            legendItem(color: T.band, label: "unlogged")
        }
    }

    private func legendItem(color: Color, label: String) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.mono(9))
                .foregroundStyle(T.tertiary)
        }
    }

    // MARK: Per-med breakdown

    private func perMedCard(_ stats: AdherenceStats) -> some View {
        DsCard {
            Eyebrow(text: "By medication")
            if stats.perMed.isEmpty {
                EmptyNote(text: "No medications configured yet.")
            } else {
                let rows = sortedPerMed(stats.perMed)
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        medRow(row)
                        if index < rows.count - 1 {
                            Rectangle()
                                .fill(T.hairline)
                                .frame(height: 1)
                        }
                    }
                }
            }
        }
    }

    /// Sort is display prominence ONLY (owner rule): life-critical meds with
    /// explicit skips/misses surface first, then alphabetical. No dose logic
    /// or judgment attaches to the ordering.
    private func sortedPerMed(_ perMed: [AdherenceStats.PerMed]) -> [AdherenceStats.PerMed] {
        perMed.sorted { a, b in
            let aFirst = a.med.lifeCritical && a.notDone > 0
            let bFirst = b.med.lifeCritical && b.notDone > 0
            if aFirst != bFirst { return aFirst }
            return a.med.name.localizedCaseInsensitiveCompare(b.med.name) == .orderedAscending
        }
    }

    private func medRow(_ row: AdherenceStats.PerMed) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if row.med.lifeCritical {
                    StatusDot(color: T.outOfRange, size: 6)
                }
                Text(row.med.name)
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(T.ink)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text("\(row.taken) taken · \(row.notDone) skipped/missed")
                    .font(.mono(10))
                    .foregroundStyle(T.tertiary)
            }
            HStack(spacing: 10) {
                adherenceBar(pct: row.pct)
                Text(row.pct.map { "\($0)%" } ?? "—")
                    .font(.mono(12, weight: .medium))
                    .foregroundStyle(T.ink)
                    .frame(width: 42, alignment: .trailing)
            }
        }
        .padding(.vertical, 10)
    }

    /// Fill is ALWAYS green regardless of level — the bar reports a ratio,
    /// it never judges it (no thresholds, no amber/red verdicts).
    private func adherenceBar(pct: Int?) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(T.chip)
                if let pct {
                    Capsule()
                        .fill(T.green)
                        .frame(width: max(geo.size.width * CGFloat(pct) / 100, pct > 0 ? 4 : 0))
                }
            }
        }
        .frame(height: 4)
    }
}
