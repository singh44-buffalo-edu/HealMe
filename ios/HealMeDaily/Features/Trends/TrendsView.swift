import SwiftUI
import Charts
import HealMeDailyKit

/// Trends — the iOS port of the web `TrendsPage` (route /trends): one chart
/// card per signal (Weight / Sleep / Mood / Energy) over a 30D/90D/1Y window.
/// Read-only: logging happens under Quick add. The web page's signal chips,
/// saved views and CSV export are desktop affordances and deliberately not
/// ported.
///
/// One FHIR read per window: the four signal codes in a single comma-OR
/// code search (weight = verified LOINC 29463-7; sleep-duration/mood/energy =
/// project-local codes — FHIR-MAPPING §2/§4), routed client-side into series.
///
/// Chart contract (a known restyle trap — do not "fix"):
/// - Absolute Y domains per metric (mood/energy 0–10, sleep 0–12 h, weight
///   auto); signals are never normalized onto a shared scale.
/// - Every observation is plotted at its own timestamp; same-day readings are
///   never collapsed or averaged.
/// - No reference bands, targets or goal lines: thresholds are for clinicians
///   to set (SR-3), and weight carries no goal (neutral framing, CLAUDE.md §6).
/// - Metric hues color the marks only — never chrome.
struct TrendsView: View {
    @Environment(AppModel.self) private var model

    // MARK: Signal catalog

    /// The four plotted signals, in card order. Codes live in
    /// `RecordAPI.loadTrendObservations`; this enum only routes and styles.
    private enum Signal: String, CaseIterable, Identifiable {
        case weight, sleep, mood, energy

        var id: String { rawValue }

        var title: String {
            switch self {
            case .weight: return "Weight"
            case .sleep: return "Sleep"
            case .mood: return "Mood"
            case .energy: return "Energy"
            }
        }

        var unit: String {
            switch self {
            case .weight: return "kg"
            case .sleep: return "h"
            case .mood, .energy: return "/10"
            }
        }

        /// Canonical metric hue — data marks only, never chrome.
        var accent: Color {
            switch self {
            case .weight: return T.Metric.weight
            case .sleep: return T.Metric.sleep
            case .mood: return T.Metric.mood
            case .energy: return T.Metric.energy
            }
        }
    }

    /// The three window presets (matches the web switcher).
    private enum Window: Int, CaseIterable, Identifiable {
        case d30 = 30, d90 = 90, y1 = 365

        var id: Int { rawValue }

        var label: String {
            switch self {
            case .d30: return "30D"
            case .d90: return "90D"
            case .y1: return "1Y"
            }
        }
    }

    /// One plotted reading — `at` is the observation's own timestamp (contract:
    /// never bucketed to a day), `iso` the raw string for display formatting.
    private struct TrendPoint: Identifiable {
        var id: Int
        var at: Date
        var value: Double
        var iso: String
    }

    // MARK: State

    /// nil until the first search resolves — the loading gate.
    @State private var series: [Signal: [TrendPoint]]?
    @State private var capped = false
    @State private var loadError: String?
    @State private var window: Window = .d90
    /// Which window the current `series` belongs to — the one-shot guard
    /// (`.task(id:)` re-fires on re-appear; only a window CHANGE refetches).
    @State private var loadedWindow: Window?

    // MARK: Body

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    PageHeader(
                        title: "Trends",
                        subtitle: "Weight, sleep, mood and energy over time — every signal on its own scale, no targets or goal lines. Log entries under Quick add."
                    )
                    VaultChip()
                }

                if let loadError {
                    ErrorBanner(message: loadError)
                }

                windowPicker

                if series == nil {
                    if loadError == nil {
                        HStack {
                            Spacer()
                            ProgressView().tint(T.green)
                            Spacer()
                        }
                        .padding(.vertical, 48)
                    }
                } else {
                    ForEach(Signal.allCases) { signal in
                        signalCard(signal)
                    }

                    if capped {
                        Text("window may exceed one page — oldest readings not shown")
                            .font(.mono(10))
                            .foregroundStyle(T.quaternary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    DisclaimerFooter()
                }
            }
            .padding(16)
        }
        .background(T.canvas)
        .navigationTitle("Trends")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: window) { await load() }
        .refreshable { await load(force: true) }
    }

    // MARK: Window picker

    /// Segmented pills (same private control as AdherenceView's window
    /// picker — selected pill is a card-white capsule on the band track).
    private var windowPicker: some View {
        HStack(spacing: 4) {
            ForEach(Window.allCases) { w in
                Button {
                    window = w
                } label: {
                    Text(w.label)
                        .font(.mono(12, weight: window == w ? .semibold : .regular))
                        .foregroundStyle(window == w ? T.ink : T.tertiary)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 36)
                        .background {
                            if window == w {
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

    // MARK: Signal cards

    private func signalCard(_ signal: Signal) -> some View {
        let points = series?[signal] ?? []
        return DsCard {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(signal.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(T.ink)
                Spacer(minLength: 8)
                if let last = points.last {
                    Text(Fmt.number(last.value))
                        .font(.mono(15, weight: .medium))
                        .foregroundStyle(T.ink)
                    Text(signal.unit)
                        .font(.mono(10))
                        .foregroundStyle(T.tertiary)
                }
                Text("· \(points.count) reading\(points.count == 1 ? "" : "s")")
                    .font(.mono(10))
                    .foregroundStyle(T.tertiary)
            }

            if points.isEmpty {
                EmptyNote(text: "No \(signal.rawValue) entries in this window — log one in Quick add.")
            } else {
                chart(signal, points)
            }
        }
    }

    /// Line + a dot per reading, each at its own timestamp (contract: raw
    /// grain, no same-day collapsing). Axes/legend hidden like every chart in
    /// the app — the header names the series, the hue is on the marks only.
    @ViewBuilder
    private func chart(_ signal: Signal, _ points: [TrendPoint]) -> some View {
        let base = Chart {
            ForEach(points) { point in
                LineMark(
                    x: .value("Date", point.at),
                    y: .value(signal.unit, point.value)
                )
                .interpolationMethod(.monotone)
                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                .foregroundStyle(signal.accent)

                PointMark(
                    x: .value("Date", point.at),
                    y: .value(signal.unit, point.value)
                )
                .foregroundStyle(signal.accent)
                .symbolSize(20)
            }
        }
        .chartYAxis(.hidden)
        .chartXAxis { dateAxis }
        .chartLegend(.hidden)
        .frame(height: 170)

        // Absolute per-metric Y domains (chart contract). These are DISPLAY
        // scales matching the signals' value ranges — not clinical bands.
        switch signal {
        case .weight:
            base.chartYScale(domain: .automatic(includesZero: false))
        case .sleep:
            base.chartYScale(domain: 0 ... 12)
        case .mood, .energy:
            base.chartYScale(domain: 0 ... 10)
        }
    }

    /// Mono date ticks: month-only on the year axis, "JUL 5" on 30/90 days.
    private var dateAxis: some AxisContent {
        AxisMarks(values: .automatic(desiredCount: 4)) { value in
            AxisValueLabel {
                if let day = value.as(Date.self) {
                    Text(Self.dateTick(day, monthOnly: window == .y1))
                        .font(.mono(9))
                        .foregroundStyle(T.quaternary)
                }
            }
        }
    }

    // MARK: Load

    /// One bounded, server-side-filtered search per window; `.task(id:)`
    /// re-runs on window change and re-appear, the `loadedWindow` guard makes
    /// re-appear free. `force` (pull-to-refresh) always refetches, keeping the
    /// current charts visible while it runs.
    private func load(force: Bool = false) async {
        guard force || loadedWindow != window else { return }
        // On a window CHANGE drop the old points first — charts from the
        // previous window would silently mislabel the new one.
        if loadedWindow != window {
            series = nil
        }
        loadError = nil
        // .task(id:) cancels the running load when the window changes again;
        // a cancelled load must not publish its (old-window) results or its
        // cancellation error over the successor's state.
        let requested = window
        do {
            let observations = try await model.record.loadTrendObservations(days: requested.rawValue)
            guard !Task.isCancelled, requested == window else { return }
            // Cheap truncation guard: a full 1000-result page means the window
            // (probably) holds more readings; newest-first sort clips the
            // OLDEST edge, disclosed by the footer note.
            capped = observations.count == 1000
            // Downstream (line direction, latest = last element) expects
            // oldest-first — restore ascending order once.
            let ascending = observations.reversed()

            var next: [Signal: [TrendPoint]] = [:]
            var index = 0
            for obs in ascending {
                // HealthKit sleep nights carry effectivePeriod (no dateTime) —
                // plot period-valued observations at the period's END.
                guard let iso = obs.effectiveDateTime ?? obs.effectivePeriod?.end ?? obs.effectivePeriod?.start,
                      !iso.isEmpty else { continue }
                // Full instants parse directly; date-only entries (importers)
                // fall back to local midnight — same rule as Fmt.when.
                guard let at = RecordAPI.parseInstant(iso) ?? Fmt.localDay(String(iso.prefix(10))) else { continue }
                guard let routed = Self.route(obs) else { continue }
                next[routed.signal, default: []].append(
                    TrendPoint(id: index, at: at, value: routed.value, iso: iso)
                )
                index += 1
            }
            series = next
            loadedWindow = requested
            loadError = nil
        } catch {
            guard !Task.isCancelled, requested == window else { return }
            loadError = error.localizedDescription
        }
    }

    /// Route one observation into its signal series — verified/local codes
    /// only, exactly the set the search asked for; anything else is not
    /// plotted, never guessed at.
    private static func route(_ obs: FHIRObservation) -> (signal: Signal, value: Double)? {
        if obs.code?.code(in: FHIR.loinc) == "29463-7", let value = obs.valueQuantity?.value {
            return (.weight, value)
        }
        switch obs.code?.code(in: FHIR.csObservation) {
        case "sleep-duration":
            return obs.valueQuantity?.value.map { (.sleep, $0) }
        case "mood":
            return obs.valueInteger.map { (.mood, Double($0)) }
        case "energy":
            return obs.valueInteger.map { (.energy, Double($0)) }
        default:
            return nil
        }
    }

    // MARK: Axis formatting

    private static let monthAbbrev = [
        "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
        "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
    ]

    private static func dateTick(_ day: Date, monthOnly: Bool) -> String {
        let c = Calendar.current.dateComponents([.month, .day], from: day)
        let month = monthAbbrev[(c.month ?? 1) - 1]
        return monthOnly ? month : "\(month) \(c.day ?? 0)"
    }
}
