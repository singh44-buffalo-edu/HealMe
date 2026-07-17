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
/// - Per-sample kinds (weight, BP, SpO₂, temperature) use anchored queries;
///   the anchor cursor persists across launches so only new samples upload.
/// - Sync runs on enable and on each foregrounding; HKObserverQuery +
///   background delivery nudge a sync when new samples arrive while the app
///   is running. All authorization states degrade gracefully.
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
    /// Anchors advanced by the current sync, committed only after the server
    /// accepted the corresponding samples (never before — see anchoredSamples).
    private var pendingAnchors: [HealthKitMapping.Kind: HKQueryAnchor] = [:]
    /// Current data layer — refreshed on every bootstrap so observer nudges
    /// and syncs never keep writing through a stale client after the owner
    /// changes the server URL.
    private var record: RecordAPI?

    /// Trailing window of finished days recomputed per sync.
    private let aggregateWindowDays = 30

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
            // Deliberately reads self.record at FIRE time, not registration
            // time — a server change swaps the data layer under the observers.
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, _ in
                Task { @MainActor [weak self] in
                    guard let self, self.enabled, let record = self.record else {
                        completion()
                        return
                    }
                    await self.sync(record: record)
                    completion()
                }
            }
            store.execute(query)
            // Best-effort: background delivery needs the entitlement; when it
            // is missing this fails quietly and foreground syncs still run.
            store.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in }
        }
    }

    // MARK: Sync

    func sync(record: RecordAPI) async {
        guard enabled, !syncing else { return }
        self.record = record
        syncing = true
        defer { syncing = false }
        lastError = nil
        pendingAnchors = [:]
        do {
            var samples: [HealthKitMapping.Sample] = []
            samples += try await dailyStepAggregates()
            samples += try await dailyQuantityAverages(.restingHeartRate, kind: .restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute()))
            samples += try await dailyQuantityAverages(.heartRateVariabilitySDNN, kind: .hrvSDNN, unit: .secondUnit(with: .milli))
            samples += try await nightlySleepAggregates()
            for (kind, identifier, unit) in Self.quantityTypes {
                samples += try await anchoredQuantitySamples(identifier, kind: kind, unit: unit)
            }
            samples += try await anchoredBloodPressure()

            if !samples.isEmpty {
                let observations = samples.map { HealthKitMapping.observation(for: $0) }
                let outcome = try await record.saveHealthKitObservations(observations)
                lastSummary = "\(outcome.saved) synced" + (outcome.corrected > 0 ? ", \(outcome.corrected) corrected" : "")
            } else {
                lastSummary = "Up to date — nothing new"
            }
            // Server accepted everything (or nothing was new) — NOW the
            // anchor cursors may advance. On any failure above they stay
            // put and the same samples are re-fetched next sync; the
            // identifier convention makes the overlap converge.
            for (kind, anchor) in pendingAnchors {
                saveAnchor(anchor, for: kind)
            }
            pendingAnchors = [:]
            lastSyncAt = Date()
        } catch {
            pendingAnchors = [:]
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
    /// bucketed by the night's END date, summed to hours. The bucket rule
    /// (sample ends before today) keeps identity stable across re-syncs.
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

    private func anchoredSamples(type: HKSampleType, kind: HealthKitMapping.Kind) async throws -> [HKSample] {
        let previous = loadAnchor(kind)
        let (samples, newAnchor) = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<([HKSample], HKQueryAnchor?), Error>) in
            let query = HKAnchoredObjectQuery(type: type, predicate: nil, anchor: previous, limit: HKObjectQueryNoLimit) { _, added, _, anchor, error in
                if let error { continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: (added ?? [], anchor))
            }
            store.execute(query)
        }
        // NOT persisted yet: an anchor saved before the server write would
        // permanently skip these samples if the upload fails. sync() commits
        // all pending anchors only after a successful save.
        if let newAnchor { pendingAnchors[kind] = newAnchor }
        return samples
    }

    private func anchoredQuantitySamples(
        _ identifier: HKQuantityTypeIdentifier,
        kind: HealthKitMapping.Kind,
        unit: HKUnit
    ) async throws -> [HealthKitMapping.Sample] {
        let samples = try await anchoredSamples(type: HKQuantityType(identifier), kind: kind)
        return samples.compactMap { sample in
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

    private func anchoredBloodPressure() async throws -> [HealthKitMapping.Sample] {
        guard let type = HKObjectType.correlationType(forIdentifier: .bloodPressure) else { return [] }
        let systolicType = HKQuantityType(.bloodPressureSystolic)
        let diastolicType = HKQuantityType(.bloodPressureDiastolic)
        let samples = try await anchoredSamples(type: type, kind: .bloodPressure)
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
