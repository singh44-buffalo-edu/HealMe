import Foundation
import HealthKit
import HealMeDailyKit

/// Apple Health → Medplum sync (opt-in, Settings toggle).
///
/// Scope (owner-approved): steps, resting heart rate, HRV (SDNN), sleep,
/// body mass, blood pressure, SpO₂, body temperature — READ-only; the app
/// never writes back to HealthKit. Mapping/codes live in the Kit
/// (HealthKitMapping) so they are unit-tested on macOS; this file owns only
/// the HealthKit plumbing:
///
/// - Daily-aggregate kinds (steps, resting HR, HRV, sleep) are recomputed
///   for the trailing window of FINISHED days each sync — values are final,
///   and the {kind}-{date} identifier makes re-syncs converge.
/// - Per-sample kinds (weight, BP, SpO₂, temperature) use anchored queries
///   in bounded chunks; each chunk's anchor commits only after the server
///   accepts that chunk and persists across launches, so only new samples
///   upload and an interrupted backfill resumes where it stopped. First
///   enable backfills the trailing year only (see syncAnchoredChunks).
/// - Sync runs on enable and on each foregrounding; HKObserverQuery +
///   background delivery nudge a sync when new samples arrive. Observer
///   callbacks complete promptly and the nudged sync runs inside an
///   expiring-activity window (nudgeBackgroundSync), so a background wake
///   never suspends mid-upload. All authorization states degrade gracefully.
@MainActor
@Observable
final class HealthKitService {

    enum Status: Equatable {
        case unavailable // no HealthKit on this device
        case off // toggle off
        case requesting // permission sheet up
        case on // enabled (HealthKit hides read-denials —
        // denied types simply yield no samples)
    }

    private(set) var status: Status = .off
    private(set) var lastSyncAt: Date?
    private(set) var lastSummary: String?
    private(set) var lastError: String?
    private(set) var syncing = false

    private let store = HKHealthStore()
    private var observersRegistered = false
    /// The observer-nudged sync currently running inside an expiring-activity
    /// window; cancelled when that window closes (see nudgeBackgroundSync).
    private var backgroundSyncTask: Task<Void, Never>?
    /// Current data layer — refreshed on every bootstrap so observer nudges
    /// and syncs never keep writing through a stale client after the owner
    /// changes the server URL.
    private var record: RecordAPI?

    /// Trailing window of finished days recomputed per sync.
    private let aggregateWindowDays = 30
    /// Initial-backfill bound for anchored kinds (see syncAnchoredChunks).
    private let backfillWindowDays = 365
    /// Samples per anchored chunk: each chunk is uploaded and its anchor
    /// committed before the next chunk is fetched, so backfill progress is
    /// never lost to one failed request.
    private let anchorChunkLimit = 500

    // MARK: Types

    private static let quantityTypes: [(HealthKitMapping.Kind, HKQuantityTypeIdentifier, HKUnit)] = [
        (.bodyMass, .bodyMass, .gramUnit(with: .kilo)),
        (.oxygenSaturation, .oxygenSaturation, .percent()),
        (.bodyTemperature, .bodyTemperature, .degreeCelsius()),
    ]

    private static var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [
            HKQuantityType(.stepCount),
            HKQuantityType(.restingHeartRate),
            HKQuantityType(.heartRateVariabilitySDNN),
            HKQuantityType(.bodyMass),
            HKQuantityType(.bloodPressureSystolic),
            HKQuantityType(.bloodPressureDiastolic),
            HKQuantityType(.oxygenSaturation),
            HKQuantityType(.bodyTemperature),
            HKCategoryType(.sleepAnalysis),
        ]
        types.insert(HKObjectType.correlationType(forIdentifier: .bloodPressure)!)
        return types
    }

    // MARK: Enable / disable

    var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: "healthKitEnabled") }
        set { UserDefaults.standard.set(newValue, forKey: "healthKitEnabled") }
    }

    func bootstrap(record: RecordAPI) {
        self.record = record // refresh even when already registered
        guard HKHealthStore.isHealthDataAvailable() else {
            status = .unavailable
            return
        }
        if enabled {
            status = .on
            registerObservers()
            Task { await sync(record: record) }
        }
    }

    func enable(record: RecordAPI) async {
        self.record = record
        guard HKHealthStore.isHealthDataAvailable() else {
            status = .unavailable
            return
        }
        status = .requesting
        do {
            // Read-only: toShare is empty by design (no write-back).
            try await store.requestAuthorization(toShare: [], read: Self.readTypes)
            enabled = true
            status = .on
            registerObservers()
            await sync(record: record)
        } catch {
            enabled = false
            status = .off
            lastError = error.localizedDescription
        }
    }

    func disable() {
        enabled = false
        status = HKHealthStore.isHealthDataAvailable() ? .off : .unavailable
        lastSummary = nil
        lastError = nil
        // Anchors are kept: re-enabling resumes where sync left off, and the
        // identifier convention makes any overlap converge anyway.
    }

    // MARK: Observers (nudge a sync when new samples arrive)

    private func registerObservers() {
        guard !observersRegistered else { return }
        observersRegistered = true
        let nudgeTypes: [HKSampleType] = [
            HKQuantityType(.bodyMass),
            HKQuantityType(.oxygenSaturation),
            HKQuantityType(.bodyTemperature),
            HKObjectType.correlationType(forIdentifier: .bloodPressure)!,
        ]
        for type in nudgeTypes {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, _ in
                // Complete PROMPTLY (Apple's pattern): holding completion()
                // across the sync's HTTP round-trips means a background wake
                // suspends mid-await, completion never fires, HealthKit
                // counts the delivery as failed and eventually stops waking
                // us. The sync runs in its own expiring-activity window.
                completion()
                self?.nudgeBackgroundSync()
            }
            store.execute(query)
            // Best-effort: background delivery needs the entitlement; when it
            // is missing this fails quietly and foreground syncs still run.
            store.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in }
        }
    }

    /// Observer-nudged sync wrapped in an expiring-activity assertion: on a
    /// background wake the process would otherwise suspend mid-await and the
    /// upload would die half-done. When the window expires the in-flight sync
    /// is cancelled between chunks instead — every chunk already committed is
    /// safe, and the next sync resumes from the saved anchors.
    ///
    /// Deliberately reads self.record at FIRE time, not registration time —
    /// a server change swaps the data layer under the observers.
    private nonisolated func nudgeBackgroundSync() {
        ProcessInfo.processInfo.performExpiringActivity(withReason: "HealthKitService.sync") { [weak self] expired in
            guard let self else { return }
            if expired {
                // Second invocation: the window is closing — stop cleanly.
                Task { @MainActor in self.backgroundSyncTask?.cancel() }
                return
            }
            // The assertion holds only while this block runs; park its
            // (background) thread until the main-actor sync finishes.
            let done = DispatchSemaphore(value: 0)
            Task { @MainActor in
                defer { done.signal() }
                guard self.enabled, let record = self.record else { return }
                let task = Task { await self.sync(record: record) }
                self.backgroundSyncTask = task
                await task.value
                self.backgroundSyncTask = nil
            }
            done.wait()
        }
    }

    // MARK: Sync

    func sync(record: RecordAPI) async {
        guard enabled, !syncing else { return }
        self.record = record
        syncing = true
        defer { syncing = false }
        lastError = nil
        do {
            var saved = 0
            var corrected = 0

            // Daily aggregates: recomputed for the trailing window every
            // sync, so this batch is bounded (≤ aggregateWindowDays rows per
            // kind) and safe to upload in one call.
            var aggregates: [HealthKitMapping.Sample] = []
            aggregates += try await dailyStepAggregates()
            aggregates += try await dailyQuantityAverages(.restingHeartRate, kind: .restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute()))
            aggregates += try await dailyQuantityAverages(.heartRateVariabilitySDNN, kind: .hrvSDNN, unit: .secondUnit(with: .milli))
            aggregates += try await nightlySleepAggregates()
            if !aggregates.isEmpty {
                let outcome = try await record.saveHealthKitObservations(aggregates.map { HealthKitMapping.observation(for: $0) })
                saved += outcome.saved
                corrected += outcome.corrected
            }

            // Per-sample kinds: chunked anchored sync, committing each
            // chunk's anchor as the server accepts it (see syncAnchoredChunks).
            for (kind, identifier, unit) in Self.quantityTypes {
                let outcome = try await syncAnchoredChunks(type: HKQuantityType(identifier), kind: kind, record: record) { samples in
                    quantitySamples(samples, kind: kind, unit: unit)
                }
                saved += outcome.saved
                corrected += outcome.corrected
            }
            if let bloodPressureType = HKObjectType.correlationType(forIdentifier: .bloodPressure) {
                let outcome = try await syncAnchoredChunks(type: bloodPressureType, kind: .bloodPressure, record: record) { samples in
                    bloodPressureSamples(samples)
                }
                saved += outcome.saved
                corrected += outcome.corrected
            }

            if saved + corrected > 0 {
                lastSummary = "\(saved) synced" + (corrected > 0 ? ", \(corrected) corrected" : "")
            } else {
                lastSummary = "Up to date — nothing new"
            }
            lastSyncAt = Date()
        } catch {
            // A cancelled run (expiring background window) is not an error:
            // every committed chunk is safe and the next sync resumes from
            // the saved anchors.
            guard !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return }
            lastError = error.localizedDescription
        }
    }

    // MARK: Daily aggregates (finished days only)

    /// [start-of-window, start-of-today): today is never synced — its
    /// aggregates are still moving.
    private var finishedDaysInterval: DateInterval {
        let calendar = DoseEngine.gregorian
        let todayStart = calendar.startOfDay(for: Date())
        let windowStart = calendar.date(byAdding: .day, value: -aggregateWindowDays, to: todayStart) ?? todayStart
        return DateInterval(start: windowStart, end: todayStart)
    }

    private func dailyStepAggregates() async throws -> [HealthKitMapping.Sample] {
        let interval = finishedDaysInterval
        let type = HKQuantityType(.stepCount)
        let predicate = HKQuery.predicateForSamples(withStart: interval.start, end: interval.end, options: .strictStartDate)
        let statistics = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[HKStatistics], Error>) in
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: .cumulativeSum,
                anchorDate: interval.start,
                intervalComponents: DateComponents(day: 1)
            )
            query.initialResultsHandler = { _, collection, error in
                if let error { continuation.resume(throwing: error)
                    return
                }
                var out: [HKStatistics] = []
                collection?.enumerateStatistics(from: interval.start, to: interval.end) { stats, _ in
                    out.append(stats)
                }
                continuation.resume(returning: out)
            }
            store.execute(query)
        }
        return statistics.compactMap { stats in
            guard let sum = stats.sumQuantity() else { return nil }
            return HealthKitMapping.Sample(
                kind: .steps,
                value: sum.doubleValue(for: .count()).rounded(),
                start: stats.startDate,
                end: stats.endDate
            )
        }
    }

    private func dailyQuantityAverages(
        _ identifier: HKQuantityTypeIdentifier,
        kind: HealthKitMapping.Kind,
        unit: HKUnit
    ) async throws -> [HealthKitMapping.Sample] {
        let interval = finishedDaysInterval
        let type = HKQuantityType(identifier)
        let predicate = HKQuery.predicateForSamples(withStart: interval.start, end: interval.end, options: .strictStartDate)
        let statistics = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[HKStatistics], Error>) in
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: .discreteAverage,
                anchorDate: interval.start,
                intervalComponents: DateComponents(day: 1)
            )
            query.initialResultsHandler = { _, collection, error in
                if let error { continuation.resume(throwing: error)
                    return
                }
                var out: [HKStatistics] = []
                collection?.enumerateStatistics(from: interval.start, to: interval.end) { stats, _ in
                    out.append(stats)
                }
                continuation.resume(returning: out)
            }
            store.execute(query)
        }
        return statistics.compactMap { stats in
            guard let average = stats.averageQuantity() else { return nil }
            let value = average.doubleValue(for: unit)
            return HealthKitMapping.Sample(
                kind: kind,
                value: (value * 10).rounded() / 10,
                start: stats.startDate,
                end: stats.endDate
            )
        }
    }

    /// One sleep-duration Sample per finished night: asleep-stage samples
    /// bucketed by the night's END (wake-up) date, summed to hours. The dedup
    /// identifier is keyed to that same end date (HealthKitMapping special-
    /// cases sleep; the Sample's `end` is the bucket's max endDate, so its
    /// local date IS the bucket key) — a night never collides with a nap that
    /// started the same day, and its identity survives late watch data
    /// pulling the first sample across midnight. The bucket rule (sample
    /// ends before today) keeps values final across re-syncs.
    private func nightlySleepAggregates() async throws -> [HealthKitMapping.Sample] {
        let interval = finishedDaysInterval
        let type = HKCategoryType(.sleepAnalysis)
        let predicate = HKQuery.predicateForSamples(withStart: interval.start, end: interval.end, options: [])
        let samples = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[HKCategorySample], Error>) in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, results, error in
                if let error { continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: (results as? [HKCategorySample]) ?? [])
            }
            store.execute(query)
        }
        let asleepValues = Set(HKCategoryValueSleepAnalysis.allAsleepValues.map(\.rawValue))
        var nights: [String: (start: Date, end: Date, seconds: Double)] = [:]
        for sample in samples where asleepValues.contains(sample.value) {
            let night = DoseEngine.localDateString(sample.endDate)
            let seconds = sample.endDate.timeIntervalSince(sample.startDate)
            if var existing = nights[night] {
                existing.start = min(existing.start, sample.startDate)
                existing.end = max(existing.end, sample.endDate)
                existing.seconds += seconds
                nights[night] = existing
            } else {
                nights[night] = (sample.startDate, sample.endDate, seconds)
            }
        }
        return nights.values.map { night in
            HealthKitMapping.Sample(
                kind: .sleepDuration,
                value: ((night.seconds / 3600) * 10).rounded() / 10,
                start: night.start,
                end: night.end
            )
        }
    }

    // MARK: Anchored per-sample sync

    private func anchorKey(_ kind: HealthKitMapping.Kind) -> String { "hkAnchor-\(kind.rawValue)" }

    private func loadAnchor(_ kind: HealthKitMapping.Kind) -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: anchorKey(kind)) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func saveAnchor(_ anchor: HKQueryAnchor?, for kind: HealthKitMapping.Kind) {
        guard let anchor,
              let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
        else { return }
        UserDefaults.standard.set(data, forKey: anchorKey(kind))
    }

    /// Chunked anchored sync for one kind: fetch up to anchorChunkLimit
    /// samples, upload them, THEN commit that chunk's anchor. The anchor-
    /// only-advances-after-server-accept invariant holds per chunk — an
    /// anchor saved before the server write would permanently skip those
    /// samples if the upload failed, while a failure mid-backfill now loses
    /// at most one chunk and the next sync re-fetches exactly that chunk
    /// (the identifier convention makes the overlap converge).
    ///
    /// First enable (no stored anchor) is bounded to the trailing year:
    /// privacy-light default, and it keeps a first sync from replaying the
    /// entire multi-year Health archive over HTTP — older history can be
    /// imported via the web importers instead.
    private func syncAnchoredChunks(
        type: HKSampleType,
        kind: HealthKitMapping.Kind,
        record: RecordAPI,
        map: ([HKSample]) -> [HealthKitMapping.Sample]
    ) async throws -> (saved: Int, corrected: Int) {
        var anchor = loadAnchor(kind)
        // Decided once, BEFORE the loop mints anchors: an anchor is a store-
        // journal position, so the predicate must stay constant across the
        // chunks it threads through. Once a backfill anchor exists, later
        // syncs run unbounded (the anchor already limits them to new data).
        let predicate: NSPredicate? = anchor == nil
            ? HKQuery.predicateForSamples(withStart: DoseEngine.gregorian.date(byAdding: .day, value: -backfillWindowDays, to: Date()), end: nil, options: [])
            : nil
        var saved = 0
        var corrected = 0
        while true {
            try Task.checkCancellation() // expiring background window → stop between chunks
            let (samples, newAnchor) = try await anchoredChunk(type: type, predicate: predicate, anchor: anchor)
            let mapped = map(samples)
            if !mapped.isEmpty {
                let outcome = try await record.saveHealthKitObservations(mapped.map { HealthKitMapping.observation(for: $0) })
                saved += outcome.saved
                corrected += outcome.corrected
            }
            // Server accepted this chunk (or it mapped to nothing) — NOW its
            // anchor may advance. On any failure above it stays put.
            saveAnchor(newAnchor, for: kind)
            // A short chunk means the backlog is drained; a nil anchor would
            // only re-fetch the same chunk forever, so stop on that too.
            guard samples.count == anchorChunkLimit, let newAnchor else { break }
            anchor = newAnchor
        }
        return (saved, corrected)
    }

    private func anchoredChunk(
        type: HKSampleType,
        predicate: NSPredicate?,
        anchor: HKQueryAnchor?
    ) async throws -> ([HKSample], HKQueryAnchor?) {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<([HKSample], HKQueryAnchor?), Error>) in
            let query = HKAnchoredObjectQuery(type: type, predicate: predicate, anchor: anchor, limit: anchorChunkLimit) { _, added, _, newAnchor, error in
                if let error { continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: (added ?? [], newAnchor))
            }
            store.execute(query)
        }
    }

    private func quantitySamples(
        _ samples: [HKSample],
        kind: HealthKitMapping.Kind,
        unit: HKUnit
    ) -> [HealthKitMapping.Sample] {
        samples.compactMap { sample in
            guard let quantity = (sample as? HKQuantitySample)?.quantity else { return nil }
            var value = quantity.doubleValue(for: unit)
            if kind == .oxygenSaturation { value *= 100 } // HK percent is 0…1
            return HealthKitMapping.Sample(
                kind: kind,
                uuid: sample.uuid.uuidString,
                value: (value * 100).rounded() / 100,
                start: sample.startDate,
                end: sample.endDate
            )
        }
    }

    private func bloodPressureSamples(_ samples: [HKSample]) -> [HealthKitMapping.Sample] {
        let systolicType = HKQuantityType(.bloodPressureSystolic)
        let diastolicType = HKQuantityType(.bloodPressureDiastolic)
        return samples.compactMap { sample in
            guard let correlation = sample as? HKCorrelation,
                  let systolic = (correlation.objects(for: systolicType).first as? HKQuantitySample)?
                  .quantity.doubleValue(for: .millimeterOfMercury()),
                  let diastolic = (correlation.objects(for: diastolicType).first as? HKQuantitySample)?
                  .quantity.doubleValue(for: .millimeterOfMercury())
            else { return nil }
            return HealthKitMapping.Sample(
                kind: .bloodPressure,
                uuid: correlation.uuid.uuidString,
                value: systolic.rounded(),
                secondary: diastolic.rounded(),
                start: correlation.startDate,
                end: correlation.endDate
            )
        }
    }
}
