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

    /// Momentary feeling check-in reminders per day (0 = off; 2/3/4), evenly
    /// spaced within 09:00–21:00. Client-local notifications only — no server
    /// resources (FHIR-MAPPING §4), and the payload carries no health data.
    var feelingRemindersPerDay: Int {
        didSet { UserDefaults.standard.set(feelingRemindersPerDay, forKey: "feelingRemindersPerDay") }
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

    /// Presents the momentary feeling capture sheet (Today card + the
    /// "feeling" notification deep-link both flip this; MainTabView hosts
    /// the sheet so it opens from any tab).
    var showFeelingCapture = false

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
    /// When `usingCachedCore`, the time that snapshot was saved — drives the
    /// "updated 2h ago" note in the cached-copy banner. nil once server
    /// truth replaces the snapshot.
    private(set) var cachedCoreSavedAt: Date?
    /// Queued entries held back by the last drain because they were queued
    /// under a different sign-in (never auto-discarded; see DrainReport).
    private(set) var heldForOtherProfile = 0
    /// Name of a corrupt outbox file that load set aside (one-time notice:
    /// those queued changes could not be restored automatically).
    private(set) var outboxCorruptFileNotice: String?

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
        feelingRemindersPerDay = defaults.integer(forKey: "feelingRemindersPerDay")

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
        // Surface (once) a corrupt outbox file the load had to set aside —
        // it may hold undelivered health writes for manual recovery.
        outboxCorruptFileNotice = await outbox.corruptFileSetAside()
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
        cachedCoreSavedAt = nil
        heldForOtherProfile = 0
        // The next sign-in may be a different profile — new queue entries
        // must not carry this session's patient binding.
        await sync.setCurrentProfile(nil)
        // Snapshot cleared with the session (a signed-out device keeps no
        // readable record cache). The outbox is kept: queued dose logs are
        // the owner's clinical record and drain after the next sign-in —
        // Settings shows the pending count so nothing is silently held.
        await snapshots.clear()
        // The Health Review share PDF lives beside the snapshot (see the
        // lifecycle note on HealthReviewView.pdfFileURL) — same rule: a
        // signed-out device keeps no readable clinical files.
        try? FileManager.default.removeItem(at: HealthReviewView.pdfFileURL)
        ReminderScheduler.cancelAll()
        // Feeling reminders carry no data at all, but a signed-out device
        // prompting for check-ins it can't record would be noise — cancel;
        // afterSignIn re-arms them from the kept preference.
        ReminderScheduler.cancelFeelingCheckins()
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
            await snapshots.clear()
            pendingDoseIdents = []
            heldForOtherProfile = 0
            cachedCoreSavedAt = nil
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
        // Re-arm feeling check-in reminders (sign-out cancels them; the
        // cadence preference survives). Static daily slots — no data needed.
        if feelingRemindersPerDay > 0 {
            ReminderScheduler.rescheduleFeelingCheckins(timesPerDay: feelingRemindersPerDay)
        }
        // refreshCore drains the outbox first (drain-before-reads), so one
        // pass both delivers queued writes and loads the fresh record.
        await refreshCore()
    }

    /// Deep-link target from a tapped notification (server push or local
    /// feeling reminder). Non-clinical by contract (a screen name only).
    /// "today" refreshes the dose panel; "feeling" additionally presents the
    /// momentary feeling capture sheet.
    func route(to target: String) {
        switch target {
        case "today":
            selectedTab = 0
            _Concurrency.Task { await refreshCore() }
        case "feeling":
            selectedTab = 0
            showFeelingCapture = true
        default:
            selectedTab = 0
        }
    }

    // MARK: Shared data

    /// Load the med list + 91-day dose window + patient — the slot model
    /// Today/Meds/Adherence all share. Safe to call repeatedly (pull to
    /// refresh, after logging a dose).
    func refreshCore() async {
        // Deliver queued writes BEFORE the reads (drain-before-reads): a
        // successful refresh proves the server reachable, so queued entries
        // must go first — refresh-then-drain would render pre-drain server
        // truth (flipping queued-echo slots back for a beat) and leave the
        // writes sitting until some other trigger. This also gives queued
        // writes a retry on every pull-to-refresh while foregrounded, not
        // only on offline→online / scene transitions.
        await performDrain()
        guard authState == .signedIn else { return } // session died mid-drain
        do {
            patient = try await record.getPatient()
            // Bind the sync engine to this session's patient so entries
            // queued from now on carry it (see OutboxEntry.profileRef).
            await sync.setCurrentProfile((patient?.id).map { "Patient/\($0)" })
            meds = try await record.loadMeds()
            // 91 = 13 weeks, the web's HEATMAP_DAYS (AdherencePage) — both
            // apps must fetch the same window or their stats would disagree.
            admins = try await record.loadAdmins(days: 91)
            coreLoadError = nil
            coreLoaded = true
            usingCachedCore = false
            cachedCoreSavedAt = nil
            // Server truth replaces any queued-echo state (queued entries
            // still pending are re-echoed below so their slots stay flipped).
            await reapplyQueuedEchoes()
            await snapshots.save(CoreSnapshot(patient: patient, meds: meds, admins: admins))
            if remindersEnabled {
                ReminderScheduler.reschedule(meds: meds, showMedName: remindersShowMedName)
            }
        } catch let error as MedplumError {
            if case .unauthenticated = error {
                authState = .signedOut
                return
            }
            coreLoadError = error.localizedDescription
            if case .network = error, !coreLoaded, let cached = await snapshots.load() {
                // Cold launch with no connectivity: show the last-known
                // record, clearly labeled, instead of an empty app.
                patient = cached.patient
                meds = cached.meds
                admins = cached.admins
                coreLoaded = true
                usingCachedCore = true
                cachedCoreSavedAt = cached.savedAt
                coreLoadError = nil
                await sync.setCurrentProfile((cached.patient?.id).map { "Patient/\($0)" })
                await reapplyQueuedEchoes()
            }
        } catch {
            coreLoadError = error.localizedDescription
        }
        reviewQueueCount = (try? await record.reviewQueueCount()) ?? reviewQueueCount
        await refreshPendingCount()
    }

    /// Banner copy for the cached-core state, with the snapshot's age; a
    /// copy older than 48h gets escalated wording.
    var cachedCoreBannerText: String {
        let base = "Showing the last copy saved on this device"
        guard let savedAt = cachedCoreSavedAt else { return "\(base)." }
        let age = Self.snapshotAgeFormatter.localizedString(for: savedAt, relativeTo: Date())
        let stale = Date().timeIntervalSince(savedAt) > 48 * 3600
        return stale
            ? "Stale copy — \(base.lowercased()) · updated \(age)."
            : "\(base) · updated \(age)."
    }

    private static let snapshotAgeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

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
        let report = await performDrain()
        // Refresh not only when entries were applied: connectivity returning
        // with an EMPTY outbox must still replace a cached snapshot (or a
        // failed load) with server truth — otherwise a week-old copy renders
        // as today's dose panel for the whole session.
        let coreIsStale = usingCachedCore || coreLoadError != nil
        if authState == .signedIn, (report?.applied ?? 0) > 0 || coreIsStale {
            await refreshCore()
        }
    }

    /// One drain pass over the outbox; failures, auth-stop and held counts
    /// land in app state here. Deliberately does NOT reload the core caches
    /// — callers decide (drainOutbox refreshes when needed; refreshCore IS
    /// the refresh and calls this first, so it must not recurse).
    @discardableResult
    private func performDrain() async -> DrainReport? {
        guard authState == .signedIn else { return nil }
        guard await outbox.count > 0 else {
            heldForOtherProfile = 0
            await refreshPendingCount()
            return nil
        }
        let report = await sync.drain()
        if !report.failures.isEmpty {
            syncFailures = report.failures.map { "\($0.label): \($0.message)" }
        }
        heldForOtherProfile = report.heldForOtherProfile
        if report.stoppedForAuth {
            // The session was definitively rejected mid-drain (the client
            // already wiped its tokens). Reflect it — otherwise the app
            // stays visually signed in and the "syncs when your server is
            // reachable" banner promises a sync that can never happen.
            // Entries stay queued and drain after the next sign-in.
            authState = .signedOut
        }
        pendingDoseIdents = Set(await queuedDoseIdents())
        await refreshPendingCount()
        return report
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

    /// Feeling check-in cadence changed — re-request permission and
    /// reschedule the fixed daily slots (independent of dose reminders).
    func feelingRemindersSettingChanged() {
        if feelingRemindersPerDay > 0 {
            ReminderScheduler.requestPermissionAndScheduleFeelingCheckins(timesPerDay: feelingRemindersPerDay)
        } else {
            ReminderScheduler.cancelFeelingCheckins()
        }
    }
}
