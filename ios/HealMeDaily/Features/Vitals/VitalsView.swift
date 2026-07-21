import SwiftUI
import Charts
import HealMeDailyKit

/// Vitals dashboard — the iOS port of the web `VitalsPage` (route /vitals):
/// hero chart, 2×2 stats grid and recent-readings log with a metric switcher
/// (BP / Heart / Temp / SpO₂ / Glucose). Read-only: logging happens under
/// Quick add.
///
/// One FHIR read on appear: FHIRObservation category=vital-signs date=ge{365d}
/// _count=1000 _sort=-date, split client-side by FHIR-MAPPING §2's VERIFIED
/// LOINC codes — the BP panel (85354-9) unpacks its systolic/diastolic
/// components; every other vitals code becomes its own single-value series.
/// Unrecognized codes are simply not plotted, never guessed at. Newest-first
/// sort means a year past the 1000-result page max clips its OLDEST edge
/// (disclosed by a mono note), never the latest reading; the view reverses
/// back to ascending before splitting.
///
/// Medical-safety framing (owner-approved, non-negotiable):
/// - Stats are plain arithmetic means/ranges — no thresholds, no "high/low"
///   verdicts (spec SR-3; the subtitle says so to the user).
/// - Three-data-classes rule: readings whose provenance is a confirmed AI
///   extraction carry the indigo ✦ chip; everything else stays ink. Indigo
///   never appears on non-AI content.
/// - Metric hues color data (line, dot, reading dots) only — never chrome.
struct VitalsView: View {
    @Environment(AppModel.self) private var model

    // MARK: Metric catalog

    /// The five switchable vitals. LOINC codes are the verified set from
    /// FHIR-MAPPING §2's vitals row — never invented. BP is special-cased
    /// everywhere because it is a component panel, not one valueQuantity.
    private enum VitalMetric: String, CaseIterable, Identifiable {
        case bp, heart, temp, spo2, glucose

        var id: String { rawValue }

        var tab: String {
            switch self {
            case .bp: return "BP"
            case .heart: return "Heart"
            case .temp: return "Temp"
            case .spo2: return "SpO₂"
            case .glucose: return "Glucose"
            }
        }

        var title: String {
            switch self {
            case .bp: return "Blood pressure"
            case .heart: return "Heart rate"
            case .temp: return "Body temperature"
            case .spo2: return "SpO2"
            case .glucose: return "Glucose"
            }
        }

        var unit: String {
            switch self {
            case .bp: return "mmHg"
            case .heart: return "/min"
            case .temp: return "°C"
            case .spo2: return "%"
            case .glucose: return "mg/dL"
            }
        }

        var loinc: String {
            switch self {
            case .bp: return "85354-9"
            case .heart: return "8867-4"
            case .temp: return "8310-5"
            case .spo2: return "59408-5"
            case .glucose: return "2339-0"
            }
        }

        /// Canonical metric hue — data only, never chrome.
        var accent: Color {
            switch self {
            case .bp: return T.Metric.bp
            case .heart: return T.Metric.heart
            case .temp: return T.Metric.activity
            case .spo2: return T.Metric.respiratory
            case .glucose: return T.Metric.glucose
            }
        }
    }

    // MARK: Series value types

    /// One single-value reading (date is the local YYYY-MM-DD slice; `at` the
    /// full effectiveDateTime for display).
    private struct VitalPoint {
        var date: String
        var value: Double
        var at: String
        var source: String
    }

    /// One BP panel reading — either component may be absent.
    private struct BpPoint {
        var date: String
        var systolic: Double?
        var diastolic: Double?
        var at: String
        var source: String
    }

    private struct VitalStat: Identifiable {
        var label: String
        var value: String
        var unit: String?
        var note: String
        var id: String { label }
    }

    private struct ReadingRow: Identifiable {
        var id: Int
        var value: String
        var suffix: String
        var source: String
        var when: String
        var isAI: Bool { source == "AI-read · confirmed" }
    }

    /// Chart-ready point (Swift Charts wants Date on the x axis).
    private struct DayPoint: Identifiable {
        var id: Int
        var day: Date
        var value: Double
    }

    private struct BpChartPoint: Identifiable {
        var id: String
        var day: Date
        var systolic: Bool
        var value: Double
    }

    // MARK: State

    /// nil until the one search on appear resolves — the loading gate.
    @State private var bp: [BpPoint]?
    @State private var series: [String: [VitalPoint]] = [:]
    @State private var capped = false
    @State private var loadError: String?
    @State private var metric: VitalMetric = .bp
    @State private var didLoad = false

    // MARK: Body

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    PageHeader(
                        title: "Vitals",
                        subtitle: "Trends over the last year — log readings under Quick add. Values are shown "
                            + "without clinical judgment; thresholds worth flagging are something to set with your clinician."
                    )
                    VaultChip()
                }

                if let loadError {
                    ErrorBanner(message: loadError)
                }

                if capped {
                    Text("1,000-reading cap reached — the oldest vitals in this 1-year window are not shown.")
                        .font(.mono(10.5))
                        .foregroundStyle(T.quaternary)
                }

                Picker("Metric", selection: $metric) {
                    ForEach(VitalMetric.allCases) { m in
                        Text(m.tab).tag(m)
                    }
                }
                .pickerStyle(.segmented)

                if bp == nil {
                    if loadError == nil {
                        HStack {
                            Spacer()
                            ProgressView().tint(T.green)
                            Spacer()
                        }
                        .padding(.vertical, 48)
                    }
                } else {
                    heroCard
                    statsGrid
                    recentCard
                    DisclaimerFooter()
                }
            }
            .padding(16)
        }
        .background(T.canvas)
        .navigationTitle("Vitals")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    // MARK: Derived per-metric values

    private var bpPoints: [BpPoint] { bp ?? [] }

    /// Ascending points for the currently selected single-value metric.
    private var currentPoints: [VitalPoint] {
        metric == .bp ? [] : (series[metric.loinc] ?? [])
    }

    private var count: Int {
        metric == .bp ? bpPoints.count : currentPoints.count
    }

    private var emptyCopy: String {
        metric == .bp ? "No blood pressure readings yet." : "No readings yet."
    }

    /// Latest reading (big mono) + its timestamp — nil when the series is empty.
    private var latest: (value: String, at: String)? {
        if metric == .bp {
            guard let p = bpPoints.last else { return nil }
            return ("\(p.systolic.map(Fmt.number) ?? "—")/\(p.diastolic.map(Fmt.number) ?? "—")", p.at)
        }
        guard let p = currentPoints.last else { return nil }
        return (Fmt.number(p.value), p.at)
    }

    /// Local YYYY-MM-DD lower bound of the 90-day stats window.
    private var since90: String {
        let d = Calendar.current.date(byAdding: .day, value: -90, to: Date()) ?? Date()
        return DoseEngine.localDateString(d)
    }

    // MARK: Hero card

    private var heroCard: some View {
        DsCard {
            HStack(spacing: 10) {
                StatusDot(color: metric.accent, size: 8)
                Text(metric.title)
                    .font(.ui(16, weight: .semibold))
                    .foregroundStyle(T.ink)
                Spacer()
            }

            if let latest {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(latest.value)
                        .font(.mono(24, weight: .medium))
                        .foregroundStyle(T.ink)
                    Text("\(metric.unit) · \(Fmt.when(latest.at))")
                        .font(.mono(10.5))
                        .foregroundStyle(T.tertiary)
                }
            }

            if count == 0 {
                EmptyNote(text: emptyCopy)
                    .frame(minHeight: 150)
            } else if metric == .bp {
                bpChart
            } else {
                simpleChart
            }

            legendRow
        }
    }

    /// BP hero chart: two series (systolic/diastolic) in the canonical BP
    /// hues. Every chart hides its default axes/legend to match the web page
    /// — the legend row below the chart names the series instead.
    private var bpChart: some View {
        Chart {
            ForEach(bpChartPoints) { point in
                LineMark(
                    x: .value("Date", point.day),
                    y: .value("mmHg", point.value),
                    series: .value("Series", point.systolic ? "systolic" : "diastolic")
                )
                .interpolationMethod(.monotone)
                .lineStyle(StrokeStyle(lineWidth: point.systolic ? 2.2 : 2, lineCap: .round))
                .foregroundStyle(point.systolic ? T.Metric.bp : T.Metric.bpDia)
            }
            // Endpoint dots only (design: a dot on the newest point, none
            // along the line).
            if let last = bpChartPoints.last(where: { $0.systolic }) {
                PointMark(x: .value("Date", last.day), y: .value("mmHg", last.value))
                    .foregroundStyle(T.Metric.bp)
                    .symbolSize(38)
            }
            if let last = bpChartPoints.last(where: { !$0.systolic }) {
                PointMark(x: .value("Date", last.day), y: .value("mmHg", last.value))
                    .foregroundStyle(T.Metric.bpDia)
                    .symbolSize(38)
            }
        }
        // 40–200 mmHg is a stable DISPLAY window so the chart doesn't rescale
        // between visits — NOT a clinical band (SR-3: thresholds are set with
        // a clinician, never fabricated by the UI).
        .chartYScale(domain: 40 ... 200)
        .chartYAxis(.hidden)
        .chartXAxis { monthAxis }
        .chartLegend(.hidden)
        .frame(height: 190)
    }

    private var simpleChart: some View {
        Chart {
            ForEach(simpleChartPoints) { point in
                LineMark(
                    x: .value("Date", point.day),
                    y: .value(metric.unit, point.value)
                )
                .interpolationMethod(.monotone)
                .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round))
                .foregroundStyle(metric.accent)
            }
            if let last = simpleChartPoints.last {
                PointMark(x: .value("Date", last.day), y: .value(metric.unit, last.value))
                    .foregroundStyle(metric.accent)
                    .symbolSize(38)
            }
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .chartYAxis(.hidden)
        .chartXAxis { monthAxis }
        .chartLegend(.hidden)
        .frame(height: 190)
    }

    /// Month-only mono ticks suit the year-wide x axis (web: 'JUL').
    private var monthAxis: some AxisContent {
        AxisMarks(values: .automatic(desiredCount: 5)) { value in
            AxisValueLabel {
                if let day = value.as(Date.self) {
                    // maxScale: axis ticks inside a fixed-height chart —
                    // capped so labels don't collide at accessibility sizes.
                    Text(Self.monthTick(day))
                        .font(.mono(9, maxScale: 1.5))
                        .foregroundStyle(T.quaternary)
                }
            }
        }
    }

    // maxScale on the legend row: several items share one line under the
    // chart — series-key text, capped so the row survives accessibility sizes.
    private var legendRow: some View {
        HStack(spacing: 16) {
            if metric == .bp {
                (Text("—").foregroundStyle(T.Metric.bp) + Text(" systolic").foregroundStyle(T.tertiary))
                    .font(.mono(10, maxScale: 1.5))
                (Text("—").foregroundStyle(T.Metric.bpDia) + Text(" diastolic").foregroundStyle(T.tertiary))
                    .font(.mono(10, maxScale: 1.5))
            } else {
                (Text("—").foregroundStyle(metric.accent) + Text(" \(metric.title.lowercased())").foregroundStyle(T.tertiary))
                    .font(.mono(10, maxScale: 1.5))
            }
            Spacer()
            Text("\(count) reading\(count == 1 ? "" : "s") · 1Y")
                .font(.mono(10, maxScale: 1.5))
                .foregroundStyle(T.tertiary)
        }
    }

    private var bpChartPoints: [BpChartPoint] {
        var out: [BpChartPoint] = []
        for (index, p) in bpPoints.enumerated() {
            guard let day = Fmt.localDay(p.date) else { continue }
            if let s = p.systolic {
                out.append(BpChartPoint(id: "s\(index)", day: day, systolic: true, value: s))
            }
            if let d = p.diastolic {
                out.append(BpChartPoint(id: "d\(index)", day: day, systolic: false, value: d))
            }
        }
        return out
    }

    private var simpleChartPoints: [DayPoint] {
        currentPoints.enumerated().compactMap { index, p in
            Fmt.localDay(p.date).map { DayPoint(id: index, day: $0, value: p.value) }
        }
    }

    // MARK: Stats grid

    /// 2×2 grid of descriptive statistics — plain arithmetic over the loaded
    /// window, no judgment, "—" when a window is empty.
    private var statsGrid: some View {
        let stats = metric == .bp ? bpStats() : simpleStats()
        return LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
            spacing: 12
        ) {
            ForEach(stats) { stat in
                DsCard(padding: 14) {
                    VStack(alignment: .leading, spacing: 5) {
                        Eyebrow(text: stat.label)
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(stat.value)
                                .font(.mono(20, weight: .medium))
                                .foregroundStyle(T.ink)
                                .lineLimit(1)
                                .minimumScaleFactor(0.55)
                            if let unit = stat.unit {
                                Text(unit)
                                    .font(.mono(10))
                                    .foregroundStyle(T.tertiary)
                            }
                        }
                        Text(stat.note)
                            .font(.mono(10))
                            .foregroundStyle(T.quaternary)
                    }
                }
            }
        }
    }

    /// BP averages are computed per component over the readings that carry it
    /// ("120/78"); the range card shows systolic / diastolic low–high.
    private func bpStats() -> [VitalStat] {
        let recent = bpPoints.filter { $0.date >= since90 }
        func pairAvg(_ pts: [BpPoint]) -> String {
            let sys = pts.compactMap(\.systolic)
            let dia = pts.compactMap(\.diastolic)
            guard !sys.isEmpty, !dia.isEmpty else { return "—" }
            return "\(Int(Self.mean(sys).rounded()))/\(Int(Self.mean(dia).rounded()))"
        }
        let sys = bpPoints.compactMap(\.systolic)
        let dia = bpPoints.compactMap(\.diastolic)
        return [
            VitalStat(
                label: "90-day avg", value: pairAvg(recent), unit: "mmHg",
                note: recent.isEmpty ? "no readings in window" : "over \(recent.count) readings"
            ),
            VitalStat(
                label: "1-year avg", value: pairAvg(bpPoints), unit: "mmHg",
                note: bpPoints.isEmpty ? "no readings yet" : "over \(bpPoints.count) readings"
            ),
            VitalStat(
                label: "Range",
                value: sys.isEmpty && dia.isEmpty ? "—" : "\(Self.rangeText(sys)) / \(Self.rangeText(dia))",
                unit: "mmHg",
                note: "1-year low–high · sys / dia"
            ),
            VitalStat(label: "Readings", value: String(bpPoints.count), note: "last 365 days"),
        ]
    }

    private func simpleStats() -> [VitalStat] {
        let recent = currentPoints.filter { $0.date >= since90 }
        let values = currentPoints.map(\.value)
        return [
            VitalStat(
                label: "90-day avg",
                value: recent.isEmpty ? "—" : Fmt.number(Self.mean(recent.map(\.value))),
                unit: metric.unit,
                note: recent.isEmpty ? "no readings in window" : "over \(recent.count) readings"
            ),
            VitalStat(
                label: "1-year avg",
                value: values.isEmpty ? "—" : Fmt.number(Self.mean(values)),
                unit: metric.unit,
                note: values.isEmpty ? "no readings yet" : "over \(values.count) readings"
            ),
            VitalStat(
                label: "Range",
                value: values.isEmpty ? "—" : Self.rangeText(values),
                unit: metric.unit,
                note: "1-year low–high"
            ),
            VitalStat(label: "Readings", value: String(currentPoints.count), note: "last 365 days"),
        ]
    }

    // MARK: Recent readings

    private var recentRows: [ReadingRow] {
        if metric == .bp {
            return Array(bpPoints.suffix(8).reversed()).enumerated().map { index, p in
                ReadingRow(
                    id: index,
                    value: "\(p.systolic.map(Fmt.number) ?? "—")/\(p.diastolic.map(Fmt.number) ?? "—")",
                    suffix: "mmHg",
                    source: p.source,
                    when: Fmt.when(p.at)
                )
            }
        }
        return Array(currentPoints.suffix(8).reversed()).enumerated().map { index, p in
            ReadingRow(
                id: index,
                value: Fmt.number(p.value),
                suffix: metric.unit,
                source: p.source,
                when: Fmt.when(p.at)
            )
        }
    }

    private var recentCard: some View {
        DsCard {
            HStack {
                Text("Recent readings")
                    .font(.ui(14.5, weight: .semibold))
                    .foregroundStyle(T.ink)
                Spacer()
                Text("\(count) in the last year")
                    .font(.mono(10.5))
                    .foregroundStyle(T.quaternary)
            }

            if recentRows.isEmpty {
                EmptyNote(text: emptyCopy)
            } else {
                VStack(spacing: 0) {
                    ForEach(recentRows) { row in
                        if row.id > 0 {
                            Rectangle().fill(T.hairline).frame(height: 1)
                        }
                        HStack(spacing: 10) {
                            StatusDot(color: metric.accent, size: 7)
                            HStack(alignment: .firstTextBaseline, spacing: 4) {
                                Text(row.value)
                                    .font(.mono(14, weight: .medium))
                                    .foregroundStyle(T.ink)
                                Text(row.suffix)
                                    .font(.mono(9.5))
                                    .foregroundStyle(T.quaternary)
                            }
                            Spacer(minLength: 8)
                            // Three-data-classes rule: only confirmed AI
                            // extractions get the indigo ✦ chip; every other
                            // provenance stays quiet mono ink.
                            if row.isAI {
                                Chip(text: "✦ AI-read · confirmed", ai: true)
                            } else {
                                Text(row.source)
                                    .font(.mono(10))
                                    .foregroundStyle(T.quaternary)
                            }
                            Text(row.when)
                                .font(.mono(10))
                                .foregroundStyle(T.quaternary)
                        }
                        .padding(.vertical, 9)
                    }
                }
            }
        }
    }

    // MARK: Load

    /// One bounded, server-side-filtered search; metric switching and stat
    /// building are pure client-side derivation — no refetch per tab.
    private func load() async {
        guard !didLoad else { return }
        didLoad = true
        do {
            let since = Calendar.current.date(byAdding: .day, value: -365, to: Date()) ?? Date()
            let observations = try await model.record.loadObservations([
                ("category", "vital-signs"),
                ("date", "ge\(DoseEngine.localDateString(since))"),
                ("_count", "1000"),
                ("_sort", "-date"),
            ])
            // Cheap truncation guard: a full page means the year (probably)
            // holds more readings than the page max — the header note
            // discloses the clipped oldest edge.
            capped = observations.count == 1000
            // Everything downstream (endpoint dots, latest = last element,
            // suffix(8)) expects oldest-first — restore ascending order once.
            let ascending = Array(observations.reversed())

            var bpPoints: [BpPoint] = []
            var next: [String: [VitalPoint]] = [:]
            for obs in ascending {
                let at = obs.effectiveDateTime ?? ""
                let day = String(at.prefix(10))
                guard !day.isEmpty else { continue }
                // Verified LOINC only — an observation without a LOINC code
                // (or with an unrecognized one) is not plotted, never guessed.
                guard let code = obs.code?.code(in: FHIR.loinc) else { continue }
                if code == VitalMetric.bp.loinc {
                    var point = BpPoint(date: day, at: at, source: Self.sourceOf(obs))
                    for comp in obs.component ?? [] {
                        let compCode = comp.code?.coding?.first?.code
                        if compCode == "8480-6" { point.systolic = comp.valueQuantity?.value }
                        if compCode == "8462-4" { point.diastolic = comp.valueQuantity?.value }
                    }
                    if point.systolic != nil || point.diastolic != nil {
                        bpPoints.append(point)
                    }
                } else if let value = obs.valueQuantity?.value {
                    next[code, default: []].append(
                        VitalPoint(date: day, value: value, at: at, source: Self.sourceOf(obs))
                    )
                }
            }
            bp = bpPoints
            series = next
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// Factual provenance for a reading — from identifiers/tags actually
    /// written by the backend, never guessed: an ingestion identifier means
    /// the value passed the review-queue gate after AI/OCR extraction; the
    /// `imported` meta tag means a deterministic Phase-4 importer;
    /// `derivedFrom` means the check-in Bot; a HealthKit identifier means the
    /// sync wrote it (measured device data — quiet ink, not live-green);
    /// anything else was logged by hand.
    private static func sourceOf(_ obs: FHIRObservation) -> String {
        if obs.identifier?.contains(where: { $0.system == FHIR.ingestionIdentSystem }) == true {
            return "AI-read · confirmed"
        }
        if obs.meta?.tag?.contains(where: { $0.system == FHIR.tagsSystem && $0.code == "imported" }) == true {
            return "imported"
        }
        if !(obs.derivedFrom ?? []).isEmpty {
            return "check-in"
        }
        if obs.identifier?.contains(where: { $0.system == HealthKitMapping.identSystem }) == true {
            return "Apple Health"
        }
        return "logged"
    }

    // MARK: Arithmetic helpers (descriptive only — SR-3)

    private static func mean(_ values: [Double]) -> Double {
        values.reduce(0, +) / Double(values.count)
    }

    private static func rangeText(_ values: [Double]) -> String {
        guard let lo = values.min(), let hi = values.max() else { return "—" }
        return "\(Fmt.number(lo))–\(Fmt.number(hi))"
    }

    private static let monthAbbrev = [
        "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
        "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
    ]

    private static func monthTick(_ day: Date) -> String {
        monthAbbrev[Calendar.current.component(.month, from: day) - 1]
    }
}
