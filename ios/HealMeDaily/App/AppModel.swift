import Foundation
import Network
import SwiftUI
import HealMeDailyKit

/// App-wide state: server configuration, the Medplum session, and the shared
/// medication/adherence caches every screen reads. One instance lives in the
/// SwiftUI environment (`@Environment(AppModel.self)`).
///
/// Data flow mirrors the web app: screens call RecordAPI/AIService directly
/// for their own reads, but the med list + dose log window are cached here
/// because Today, Meds and Adherence all derive from the same slot model and
/// must agree with each other.
@MainActor
@Observable
final class AppModel {

    enum AuthState {
        case loading
        case signedOut
        case signedIn
    }

    // MARK: Settings (UserDefaults — never health data, never tokens)

    var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: "serverURL") }
    }

    var aiServiceURLString: String {
        didSet { UserDefaults.standard.set(aiServiceURLString, forKey: "aiServiceURL") }
    }

    /// Face ID / passcode gate on app open.
    var requireBiometrics: Bool {
        didSet { UserDefaults.standard.set(requireBiometrics, forKey: "requireBiometrics") }
    }

    /// Local dose reminders (scheduled on-device from the med schedule).
    var remindersEnabled: Bool {
        didSet { UserDefaults.standard.set(remindersEnabled, forKey: "remindersEnabled") }
    }

    /// Privacy default: lock-screen reminders say "Medication due", not the
    /// med name, unless the owner opts in.
    var remindersShowMedName: Bool {
        didSet { UserDefaults.standard.set(remindersShowMedName, forKey: "remindersShowMedName") }
    }

    // MARK: Session

    private(set) var client: MedplumClient
    private(set) var record: RecordAPI
    private(set) var ai: AIService
    private(set) var sync: SyncEngine
    private(set) var authState: AuthState = .loading
    private(set) var profileName = "Owner"
    private(set) var patient: Patient?

    /// Face ID gate state — RootView overlays LockView while false.
    var unlocked = false

    /// Apple Health sync (opt-in; read-only; see HealthKitService).
    let healthKit = HealthKitService()

    /// Remote push (opt-in; server-driven reminders; see PushService).
    let push = PushService.shared

    /// Selected bottom-tab index — a binding for MainTabView, also the target
    /// of push deep-links. 0 = Today.
    var selectedTab = 0

    // MARK: Shared record caches

    private(set) var meds: [MedInfo] = []
    /// Trailing 90-day dose-log window (identifier-matched to slots).
    private(set) var admins: [MedicationAdministration] = []
    private(set) var reviewQueueCount = 0
    private(set) var coreLoadError: String?
    private(set) var coreLoaded = false

    // MARK: Offline / sync state

    /// True while the OS reports no usable network path.
    private(set) var isOffline = false
    /// Queued (not-yet-delivered) writes in the outbox.
    private(set) var pendingWrites = 0
    /// Dose-slot identValues whose current state is a queued local echo.
    private(set) var pendingDoseIdents: Set<String> = []
    /// Writes the SERVER rejected during a drain — shown loudly, since they
    /// were dropped from the queue instead of retried forever.
    private(set) var syncFailures: [String] = []
    /// True when the visible core data came from the on-device snapshot
    /// because the server was unreachable.
    private(set) var usingCachedCore = false

    @ObservationIgnored private let outbox: OutboxStore
    @ObservationIgnored private let snapshots: SnapshotStore
    @ObservationIgnored private let pathMonitor = NWPathMonitor()

    /// App Support/HealMeDaily — outbox + core snapshot live here, encrypted
    /// at rest via iOS Data Protection (complete).
    private static var dataDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("HealMeDaily", isDirectory: true)
    }

    init() {
        let defaults = UserDefaults.standard
        serverURLString = defaults.string(forKey: "serverURL") ?? "http://localhost:8103/"
        aiServiceURLString = defaults.string(forKey: "aiServiceURL") ?? "http://localhost:8000/"
        requireBiometrics = defaults.bool(forKey: "requireBiometrics")
        remindersEnabled = defaults.bool(forKey: "remindersEnabled")
        remindersShowMedName = defaults.bool(forKey: "remindersShowMedName")

        let serverURL = URL(string: defaults.string(forKey: "serverURL") ?? "http://localhost:8103/")
            ?? URL(string: "http://localhost:8103/")!
        let aiURL = URL(string: defaults.string(forKey: "aiServiceURL") ?? "http://localhost:8000/")
            ?? URL(string: "http://localhost:8000/")!
        // Locals first: @Observable synthesizes accessors that may not be
        // touched until every stored property is initialized.
        let medplum = MedplumClient(baseURL: serverURL)
        let api = RecordAPI(client: medplum)
        let queue = OutboxStore(directory: Self.dataDirectory)
        client = medplum
        record = api
        var aiService = AIService(baseURL: aiURL)
        // The ai-service verifies the same Medplum session this app holds.
        aiService.tokenProvider = { await medplum.bearerToken() }
        ai = aiService
        outbox = queue
        snapshots = SnapshotStore(directory: Self.dataDirectory)
        sync = SyncEngine(record: api, outbox: queue)
        unlocked = !defaults.bool(forKey: "requireBiometrics")

        // Connectivity watcher: reflect offline state and drain the outbox
        // the moment a usable path returns.
        pathMonitor.pathUpdateHandler = { [weak self] path in
            _Concurrency.Task { @MainActor [weak self] in
                guard let self else { return }
                let offline = path.status != .satisfied
                let cameBackOnline = self.isOffline && !offline
                self.isOffline = offline
                if cameBackOnline, self.authState == .signedIn {
                    await self.drainOutbox()
                }
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "com.healmedaily.pathmonitor"))
    }

    // MARK: Lifecycle

    /// Called once at launch: adopt a stored Keychain session if present.
    func bootstrap() async {
        if await client.isAuthenticated {
            authState = .signedIn
            await afterSignIn()
        } else {
            authState = .signedOut
        }
    }

    func signIn(email: String, password: String) async throws {
        try await client.signIn(email: email, password: password)
        authState = .signedIn
        await afterSignIn()
    }

    func signOut() async {
        // Drop the APNs token server-side FIRST, while the session token is
        // still valid — /push/unregister is session-gated, so unregistering
        // after client.signOut() would go out tokenless, 401, and leave the
        // token live (the signed-out device would keep getting pushes). The
        // push preference is kept and re-registers on re-sign-in.
        await push.handleSignOut()
        await client.signOut()
        authState = .signedOut
        patient = nil
        meds = []
        admins = []
        coreLoaded = false
        usingCachedCore = false
        // Snapshot cleared with the session (a signed-out device keeps no
        // readable record cache). The outbox is kept: queued dose logs are
        // the owner's clinical record and drain after the next sign-in —
        // Settings shows the pending count so nothing is silently held.
        snapshots.clear()
        ReminderScheduler.cancelAll()
    }

    /// Rebuild clients after the user edits server URLs in Settings.
    /// Changing the Medplum URL invalidates the session (tokens are bound to
    /// the server that minted them), so this drops back to sign-in.
    func applyServerSettings() async {
        let previousServer = await client.baseURL.absoluteString
        let serverURL = URL(string: serverURLString) ?? URL(string: "http://localhost:8103/")!
        let aiURL = URL(string: aiServiceURLString) ?? URL(string: "http://localhost:8000/")!
        let rebuilt = MedplumClient(baseURL: serverURL)
        let api = RecordAPI(client: rebuilt)
        var aiService = AIService(baseURL: aiURL)
        aiService.tokenProvider = { await rebuilt.bearerToken() }
        ai = aiService
        client = rebuilt
        record = api
        sync = SyncEngine(record: api, outbox: outbox)
        if await rebuilt.baseURL.absoluteString != previousServer {
            // Queued writes belong to the previous server's record — never
            // replay them against a different server. Discarding is the safe
            // call, but it must be LOUD: these were health writes.
            let discarded = await outbox.count
            if discarded > 0 {
                syncFailures.append(
                    "\(discarded) unsynced change\(discarded == 1 ? "" : "s") discarded — the server URL changed before they could sync."
                )
            }
            await outbox.removeAll()
            snapshots.clear()
            pendingDoseIdents = []
            await refreshPendingCount()
        }
        if await rebuilt.isAuthenticated {
            authState = .signedIn
            await afterSignIn()
        } else {
            authState = .signedOut
        }
    }

    private func afterSignIn() async {
        profileName = (try? await client.profileDisplayName()) ?? "Owner"
        healthKit.bootstrap(record: record)
        push.configure(model: self)
        await drainOutbox()
        await refreshCore()
    }

    /// Deep-link target from a tapped push notification. Non-clinical by
    /// contract (a screen name); "today" is the only target the server sends
    /// today. Switches tabs and refreshes so the panel is current.
    func route(to target: String) {
        switch target {
        case "today":
            selectedTab = 0
            _Concurrency.Task { await refreshCore() }
        default:
            selectedTab = 0
        }
    }

    // MARK: Shared data

    /// Load the med list + 91-day dose window + patient — the slot model
    /// Today/Meds/Adherence all share. Safe to call repeatedly (pull to
    /// refresh, after logging a dose).
    func refreshCore() async {
        do {
            patient = try await record.getPatient()
            meds = try await record.loadMeds()
            // 91 = 13 weeks, the web's HEATMAP_DAYS (AdherencePage) — both
            // apps must fetch the same window or their stats would disagree.
            admins = try await record.loadAdmins(days: 91)
            coreLoadError = nil
            coreLoaded = true
            usingCachedCore = false
            // Server truth replaces any queued-echo state (queued entries
            // still pending are re-echoed below so their slots stay flipped).
            await reapplyQueuedEchoes()
            snapshots.save(CoreSnapshot(patient: patient, meds: meds, admins: admins))
            if remindersEnabled {
                ReminderScheduler.reschedule(meds: meds, showMedName: remindersShowMedName)
            }
        } catch let error as MedplumError {
            if case .unauthenticated = error {
                authState = .signedOut
                return
            }
            coreLoadError = error.localizedDescription
            if case .network = error, !coreLoaded, let cached = snapshots.load() {
                // Cold launch with no connectivity: show the last-known
                // record, clearly labeled, instead of an empty app.
                patient = cached.patient
                meds = cached.meds
                admins = cached.admins
                coreLoaded = true
                usingCachedCore = true
                coreLoadError = nil
                await reapplyQueuedEchoes()
            }
        } catch {
            coreLoadError = error.localizedDescription
        }
        reviewQueueCount = (try? await record.reviewQueueCount()) ?? reviewQueueCount
        await refreshPendingCount()
    }

    /// Log a dose and update the local cache in place so every screen's
    /// slot state flips immediately. Online, the idempotent server write is
    /// the source of truth; offline, the write queues and a local echo keeps
    /// the slot state honest until the outbox drains.
    func logDose(slot: DoseSlot, action: DoseAction, takenAt: Date? = nil) async throws {
        let result = try await sync.logDose(slot: slot, action: action, takenAt: takenAt)
        mergeAdmin(result.resource, identValue: slot.identValue)
        if result.wasQueued {
            pendingDoseIdents.insert(slot.identValue)
        } else {
            pendingDoseIdents.remove(slot.identValue)
        }
        await refreshPendingCount()
    }

    /// Submit a check-in through the offline-tolerant path.
    /// Returns true when the write was queued for later sync.
    @discardableResult
    func submitCheckin(_ def: CheckinDef, items: [QuestionnaireResponseItem]) async throws -> Bool {
        let result = try await sync.submitCheckin(def, items: items)
        await refreshPendingCount()
        return result.wasQueued
    }

    /// Save quick observations through the offline-tolerant path.
    /// Returns true when the write was queued for later sync.
    @discardableResult
    func saveQuickObservations(_ observations: [FHIRObservation]) async throws -> Bool {
        let result = try await sync.saveQuickObservations(observations)
        await refreshPendingCount()
        return result.wasQueued
    }

    /// Replay queued writes; on progress, reload from the server so echoes
    /// are replaced by server truth. Server-rejected entries surface in
    /// `syncFailures` (they are dropped from the queue, never retried
    /// silently forever).
    func drainOutbox() async {
        guard await outbox.count > 0 else {
            await refreshPendingCount()
            return
        }
        let report = await sync.drain()
        if !report.failures.isEmpty {
            syncFailures = report.failures.map { "\($0.label): \($0.message)" }
        }
        if report.applied > 0 {
            pendingDoseIdents = Set(await queuedDoseIdents())
            await refreshCore()
        } else {
            await refreshPendingCount()
        }
    }

    func dismissSyncFailures() {
        syncFailures = []
    }

    private func mergeAdmin(_ admin: MedicationAdministration, identValue: String) {
        if let index = admins.firstIndex(where: { existing in
            existing.identifier?.contains { $0.system == FHIR.administrationIdentSystem && $0.value == identValue } ?? false
        }) {
            admins[index] = admin
        } else {
            admins.append(admin)
        }
    }

    /// Slot identValues still queued in the outbox.
    private func queuedDoseIdents() async -> [String] {
        await sync.pendingEntries().compactMap { entry in
            if case .dose(let payload) = entry.kind { return payload.identValue }
            return nil
        }
    }

    /// After a fresh server load, re-echo still-queued dose entries so their
    /// slots keep showing the action the user already took.
    private func reapplyQueuedEchoes() async {
        var stillPending: Set<String> = []
        for entry in await sync.pendingEntries() {
            if case .dose(let payload) = entry.kind {
                mergeAdmin(RecordAPI.echoAdministration(payload), identValue: payload.identValue)
                stillPending.insert(payload.identValue)
            }
        }
        pendingDoseIdents = stillPending
    }

    private func refreshPendingCount() async {
        pendingWrites = await outbox.count
    }

    /// Reminder settings changed — re-request permission and reschedule.
    func remindersSettingChanged() {
        if remindersEnabled {
            ReminderScheduler.requestPermissionAndSchedule(meds: meds, showMedName: remindersShowMedName)
        } else {
            ReminderScheduler.cancelAll()
        }
    }
}
