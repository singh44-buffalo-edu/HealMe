import SwiftUI
import Charts
import HealMeDailyKit

/// Lab records — the iOS port of the web `LabsPage` (route /labs): hero
/// analyte trend chart with 1Y/3Y/ALL windows over an All-results/Flagged
/// analyte list. Read-only: lab values enter the record only through the
/// document-ingestion review queue, never from this screen.
///
/// One FHIR read on appear: the FULL lab history via
/// `record.loadLabObservations()` (category=laboratory, newest-first, no date
/// bound — draws are sparse and multi-year context is the point). Past the
/// 10-page cap the OLDEST draws drop and a mono truncation notice renders —
/// silent truncation on a labs screen is never acceptable.
///
/// Grouping mirrors the web `groupAnalytes` exactly: analyte key = display
/// name (code.text, falling back to coding display/code) PLUS the unit, so
/// same-named analytes from inconsistent source codings merge into one trend
/// — but only when their units agree (glucose in mg/dL and mmol/L stay
/// separate series instead of being charted against each other).
///
/// Reference-range rule (SR-3): the gray band on the hero chart and the
/// out-of-range coloring come from the range STATED ON THE SOURCE REPORT
/// (Observation.referenceRange, preserved by ingestion). No stated range ⇒
/// no band, no flag, no coloring — the UI never fabricates a threshold.
struct RecordsView: View {
    @Environment(AppModel.self) private var model

    // MARK: Value types

    /// One draw: date is the local YYYY-MM-DD slice of effectiveDateTime.
    private struct LabPoint {
        var date: String
        var value: Double
    }

    /// One unit-homogeneous analyte series (see grouping note in the header).
    private struct Analyte: Identifiable {
        var name: String
        var unit: String
        /// Stated bounds from the FIRST referenceRange found in the group —
        /// nil means the source reports carried none (never invented here).
        var low: Double?
        var high: Double?
        /// referenceRange.text verbatim, preferred over low/high for display.
        var rangeText: String?
        /// Ascending by draw date.
        var points: [LabPoint]
        var latest: LabPoint
        /// LATEST value outside the stated range only — a historical
        /// excursion does not flag the analyte today; no range ⇒ never flagged.
        var outOfRange: Bool
        /// Same NUL-composite as the grouping key, unique per series.
        var id: String { "\(name)\u{0}\(unit)" }
    }

    private enum ViewMode: String, CaseIterable {
        case all, flagged

        var label: String {
            switch self {
            case .all: return "All results"
            case .flagged: return "Flagged"
            }
        }
    }

    private enum HeroRange: String, CaseIterable {
        case y1 = "1Y", y3 = "3Y", all = "ALL"

        /// nil = no window (the whole history).
        var days: Int? {
            switch self {
            case .y1: return 365
            case .y3: return 1095
            case .all: return nil
            }
        }
    }

    /// Chart-ready draw (Swift Charts wants Date on the x axis).
    private struct DayPoint: Identifiable {
        var id: Int
        var day: Date
        var value: Double
    }

    /// `loadLabObservations` walks at most 10 × 1000-result pages; a result
    /// count at the ceiling means older history (probably) exists beyond it.
    private static let historyCap = 10_000

    // MARK: State

    /// nil until the one load on appear resolves — the loading gate.
    @State private var analytes: [Analyte]?
    @State private var truncated = false
    @State private var loadError: String?
    @State private var didLoad = false
    @State private var mode: ViewMode = .all
    @State private var heroRange: HeroRange = .y3
    /// Analyte promoted to the hero chart by tapping its row; nil = default
    /// (the analyte with the most draws — the longest story).
    @State private var heroID: String?

    // MARK: Body

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    PageHeader(
                        title: "Lab results",
                        subtitle: "Per-analyte trends against the reference range stated on each report — values shown exactly as reported, no thresholds invented."
                    )
                    VaultChip()
                }

                if let loadError {
                    ErrorBanner(message: loadError)
                }

                if truncated {
                    Text("history truncated — oldest draws beyond 10 pages not shown")
                        .font(.mono(10.5))
                        .foregroundStyle(T.watch)
                }

                if let analytes {
                    if analytes.isEmpty {
                        DsCard {
                            EmptyNote(text: "Lab results enter the record through document ingestion — add a report in Documents.")
                        }
                    } else {
                        summaryLine(analytes)
                        SegmentedPillsControl(
                            options: ViewMode.allCases.map { .init(value: $0, label: $0.label) },
                            selection: $mode
                        )
                        if let hero {
                            heroCard(hero)
                        }
                        listCard(analytes)
                        DisclaimerFooter()
                    }
                } else if loadError == nil {
                    HStack {
                        Spacer()
                        ProgressView().tint(T.green)
                        Spacer()
                    }
                    .padding(.vertical, 48)
                }
            }
            .padding(16)
        }
        .background(T.canvas)
        .navigationTitle("Records")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load(force: true) }
    }

    // MARK: Derived

    /// Tapped analyte, else the one with the most draws (first wins ties —
    /// mirrors the web default-hero reduce).
    private var hero: Analyte? {
        guard let analytes, !analytes.isEmpty else { return nil }
        if let heroID, let selected = analytes.first(where: { $0.id == heroID }) {
            return selected
        }
        return analytes.reduce(nil) { best, a in
            guard let best else { return a }
            return a.points.count > best.points.count ? a : best
        }
    }

    private var flagged: [Analyte] {
        (analytes ?? []).filter(\.outOfRange)
    }

    /// "12 analytes · 340 results · 6 years" — the web page's subtitle, kept
    /// in the mono data voice here.
    private func summaryLine(_ analytes: [Analyte]) -> some View {
        let total = analytes.reduce(0) { $0 + $1.points.count }
        let dates = analytes.flatMap { $0.points.map(\.date) }.sorted()
        let span = (dates.first, dates.last)
        return Text(
            "\(analytes.count) analyte\(analytes.count == 1 ? "" : "s") · \(total) result\(total == 1 ? "" : "s")"
                + ((span.0.flatMap { first in span.1.map { Self.spanText(first, $0) } }).map { " · \($0)" } ?? "")
        )
        .font(.mono(10.5))
        .foregroundStyle(T.tertiary)
    }

    // MARK: Hero trend card

    private func heroCard(_ analyte: Analyte) -> some View {
        // Windowed draws: local YYYY-MM-DD cutoff, plain string compare.
        let cutoff = heroRange.days.map { days -> String in
            let d = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
            return DoseEngine.localDateString(d)
        }
        let pts = cutoff.map { c in analyte.points.filter { $0.date >= c } } ?? analyte.points
        // Status color on the VALUE only, never flooding the card (design rule).
        let valColor = analyte.outOfRange ? T.outOfRange : T.ink

        return DsCard {
            HStack(spacing: 10) {
                StatusDot(color: T.Metric.labs, size: 8)
                Text(analyte.name)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(T.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Spacer(minLength: 8)
                SegmentedPillsControl(
                    options: HeroRange.allCases.map { .init(value: $0, label: $0.rawValue) },
                    selection: $heroRange,
                    compact: true
                )
            }

            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(Fmt.number(analyte.latest.value))
                    .font(.mono(24, weight: .medium))
                    .foregroundStyle(valColor)
                Text([analyte.unit, Fmt.when(analyte.latest.date)]
                    .filter { !$0.isEmpty }
                    .joined(separator: " · "))
                    .font(.mono(10.5))
                    .foregroundStyle(T.tertiary)
            }

            if pts.isEmpty {
                Text("No draws in this window")
                    .font(.mono(12))
                    .foregroundStyle(T.tertiary)
                    .frame(maxWidth: .infinity, minHeight: 150, alignment: .center)
            } else {
                heroChart(analyte, points: pts, valColor: valColor)
            }

            heroLegend(analyte, drawCount: pts.count)
        }
    }

    private func heroChart(_ analyte: Analyte, points: [LabPoint], valColor: Color) -> some View {
        let chartPoints = points.enumerated().compactMap { index, p in
            Fmt.localDay(p.date).map { DayPoint(id: index, day: $0, value: p.value) }
        }
        return Chart {
            // Stated reference band — drawn ONLY when the source report gives
            // BOTH bounds (SR-3: a one-sided range is never completed here).
            if let low = analyte.low, let high = analyte.high {
                RectangleMark(
                    yStart: .value("Ref low", low),
                    yEnd: .value("Ref high", high)
                )
                .foregroundStyle(T.band)
            }
            ForEach(chartPoints) { point in
                LineMark(
                    x: .value("Date", point.day),
                    y: .value(analyte.unit.isEmpty ? "Value" : analyte.unit, point.value)
                )
                .interpolationMethod(.monotone)
                .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round))
                .foregroundStyle(T.ink)
            }
            // Draws are sparse — every draw gets a small ink dot (web parity),
            // the latest an emphasized status-colored one.
            ForEach(chartPoints) { point in
                PointMark(x: .value("Date", point.day), y: .value("Value", point.value))
                    .foregroundStyle(T.ink)
                    .symbolSize(18)
            }
            if let last = chartPoints.last {
                PointMark(x: .value("Date", last.day), y: .value("Value", last.value))
                    .foregroundStyle(valColor)
                    .symbolSize(55)
            }
        }
        // Y domain stays automatic — the RectangleMark's bounds participate,
        // so a stated band is always inside the visible window.
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisValueLabel {
                    if let v = value.as(Double.self) {
                        Text(Fmt.number(v))
                            .font(.mono(9))
                            .foregroundStyle(T.quaternary)
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { value in
                AxisValueLabel {
                    if let day = value.as(Date.self) {
                        Text(Self.dateTick(day, withDay: heroRange == .y1))
                            .font(.mono(9))
                            .foregroundStyle(T.quaternary)
                    }
                }
            }
        }
        .chartLegend(.hidden)
        .frame(height: 190)
    }

    private func heroLegend(_ analyte: Analyte, drawCount: Int) -> some View {
        HStack(spacing: 16) {
            (Text("— measured").foregroundStyle(T.ink)
                + Text(" · \(drawCount) draw\(drawCount == 1 ? "" : "s")").foregroundStyle(T.tertiary))
                .font(.mono(10))
            if let low = analyte.low, let high = analyte.high {
                Text("▬ ref \(Fmt.number(low))–\(Fmt.number(high))")
                    .font(.mono(10))
                    .foregroundStyle(T.tertiary)
            }
            Spacer()
        }
    }

    // MARK: Analyte list

    private func listCard(_ analytes: [Analyte]) -> some View {
        let shown = mode == .all ? analytes : flagged
        return DsCard {
            HStack {
                Text(mode == .all ? "All results" : "Flagged")
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(T.ink)
                Spacer()
                Text("\(shown.count) of \(analytes.count) analytes")
                    .font(.mono(10.5))
                    .foregroundStyle(T.quaternary)
            }

            if shown.isEmpty {
                // mode == .flagged: the all-analytes list is never empty here
                // (the zero-labs case renders the ingestion EmptyNote instead).
                EmptyNote(text: "Nothing flagged — every latest result is inside its stated reference range.")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.element.id) { index, analyte in
                        if index > 0 {
                            Rectangle().fill(T.hairline).frame(height: 1)
                        }
                        analyteRow(analyte)
                    }
                }
            }
        }
    }

    /// One tappable analyte row — tap promotes it to the hero chart. The red
    /// dot and red value appear ONLY when the latest value sits outside the
    /// STATED range; everything else stays quiet ink.
    private func analyteRow(_ analyte: Analyte) -> some View {
        Button {
            heroID = analyte.id
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(analyte.name)
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(T.ink)
                        .multilineTextAlignment(.leading)
                    if let range = Self.rangeLabel(analyte) {
                        Text(range)
                            .font(.mono(10))
                            .foregroundStyle(T.quaternary)
                    }
                }
                Spacer(minLength: 8)
                if analyte.outOfRange {
                    StatusDot(color: T.outOfRange, size: 7)
                }
                VStack(alignment: .trailing, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(Fmt.number(analyte.latest.value))
                            .font(.mono(14, weight: .medium))
                            .foregroundStyle(analyte.outOfRange ? T.outOfRange : T.ink)
                        if !analyte.unit.isEmpty {
                            Text(analyte.unit)
                                .font(.mono(9.5))
                                .foregroundStyle(T.quaternary)
                        }
                    }
                    Text(Fmt.when(analyte.latest.date))
                        .font(.mono(10))
                        .foregroundStyle(T.quaternary)
                }
            }
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Load

    /// One paginated read; view switching, hero selection and range windows
    /// are pure client-side derivation over the snapshot — no refetch per tab.
    private func load(force: Bool = false) async {
        guard force || !didLoad else { return }
        didLoad = true
        do {
            let labs = try await model.record.loadLabObservations()
            guard !Task.isCancelled else {
                didLoad = false // navigated away mid-load — retry on return
                return
            }
            truncated = labs.count >= Self.historyCap
            analytes = Self.groupAnalytes(labs)
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

    /// Bucket raw lab Observations into per-analyte series — the behavioral
    /// twin of web `groupAnalytes`. Key = display name + NUL + unit (see file
    /// header); observations without a numeric valueQuantity or a name are
    /// skipped, points sort ascending by the YYYY-MM-DD slice of
    /// effectiveDateTime, the FIRST stated referenceRange in the group (which
    /// arrives newest-first) supplies low/high, and outOfRange is computed
    /// from the LATEST value only. Values are used exactly as stored — no
    /// unit conversion.
    private static func groupAnalytes(_ observations: [FHIRObservation]) -> [Analyte] {
        var groups: [String: (name: String, unit: String, group: [FHIRObservation])] = [:]
        for obs in observations {
            guard obs.valueQuantity?.value != nil else { continue }
            guard let name = obs.code?.text
                ?? obs.code?.coding?.first?.display
                ?? obs.code?.coding?.first?.code
            else { continue }
            let unit = obs.valueQuantity?.unit ?? ""
            // NUL-separated composite so different-unit series never merge.
            let key = "\(name)\u{0}\(unit)"
            groups[key, default: (name, unit, [])].group.append(obs)
        }
        var analytes: [Analyte] = []
        for (_, entry) in groups {
            let points = entry.group
                .compactMap { obs -> LabPoint? in
                    let date = String((obs.effectiveDateTime ?? "").prefix(10))
                    guard !date.isEmpty, let value = obs.valueQuantity?.value else { return nil }
                    return LabPoint(date: date, value: value)
                }
                .sorted { $0.date < $1.date }
            guard let latest = points.last else { continue }
            let range = entry.group.first(where: { $0.referenceRange?.first != nil })?
                .referenceRange?.first
            let low = range?.low?.value
            let high = range?.high?.value
            analytes.append(Analyte(
                name: entry.name,
                unit: entry.unit,
                low: low,
                high: high,
                rangeText: range?.text,
                points: points,
                latest: latest,
                outOfRange: (low.map { latest.value < $0 } ?? false)
                    || (high.map { latest.value > $0 } ?? false)
            ))
        }
        // Name sort with unit tie-break so same-named different-unit series
        // keep a deterministic order (Swift dictionaries don't).
        return analytes.sorted {
            $0.name == $1.name ? $0.unit < $1.unit : $0.name < $1.name
        }
    }

    // MARK: Formatting helpers

    /// Stated-range display for a row: referenceRange.text verbatim when the
    /// report carries one, else built from the stated bounds ("0–200 mg/dL",
    /// one-sided as "≥/≤"). nil when the source stated nothing.
    private static func rangeLabel(_ analyte: Analyte) -> String? {
        if let text = analyte.rangeText, !text.isEmpty { return text }
        let unit = analyte.unit.isEmpty ? "" : " \(analyte.unit)"
        switch (analyte.low, analyte.high) {
        case let (low?, high?): return "\(Fmt.number(low))–\(Fmt.number(high))\(unit)"
        case let (low?, nil): return "≥ \(Fmt.number(low))\(unit)"
        case let (nil, high?): return "≤ \(Fmt.number(high))\(unit)"
        default: return nil
        }
    }

    /// Humanized span between first and last draw: days → months → years.
    private static func spanText(_ minDate: String, _ maxDate: String) -> String {
        guard let from = Fmt.localDay(minDate), let to = Fmt.localDay(maxDate) else {
            return ""
        }
        let days = Int((to.timeIntervalSince(from) / 86400).rounded())
        if days >= 730 { return "\(Int((Double(days) / 365.25).rounded())) years" }
        if days >= 62 { return "\(Int((Double(days) / 30.44).rounded())) months" }
        return "\(max(days, 1)) day\(days == 1 ? "" : "s")"
    }

    private static let monthAbbrev = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]

    /// Axis tick: "Mar 12" inside a 1Y window, "Mar ’26" for wider ones.
    private static func dateTick(_ day: Date, withDay: Bool) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: day)
        let month = monthAbbrev[(c.month ?? 1) - 1]
        return withDay
            ? "\(month) \(c.day ?? 0)"
            : "\(month) ’\(String(format: "%02d", (c.year ?? 0) % 100))"
    }
}

// MARK: - Segmented pills (private port of the web SegmentedPills)

/// Selected pill = white card capsule on the band track — the same private
/// pattern as AdherenceView's window picker, generalized over the value type.
/// `compact` drops the fill-the-row sizing for inline use (card headers).
private struct SegmentedPillsControl<Value: Hashable>: View {
    struct Option {
        let value: Value
        let label: String
    }

    let options: [Option]
    @Binding var selection: Value
    var compact = false

    var body: some View {
        HStack(spacing: 4) {
            ForEach(options, id: \.value) { option in
                Button {
                    selection = option.value
                } label: {
                    Text(option.label)
                        .font(.mono(compact ? 11 : 12, weight: selection == option.value ? .semibold : .regular))
                        .foregroundStyle(selection == option.value ? T.ink : T.tertiary)
                        .padding(.horizontal, compact ? 10 : 0)
                        .frame(maxWidth: compact ? nil : .infinity)
                        .frame(minHeight: compact ? 28 : 36)
                        .background {
                            if selection == option.value {
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
}
