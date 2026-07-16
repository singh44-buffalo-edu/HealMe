import Foundation
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
    private(set) var authState: AuthState = .loading
    private(set) var profileName = "Owner"
    private(set) var patient: Patient?

    /// Face ID gate state — RootView overlays LockView while false.
    var unlocked = false

    // MARK: Shared record caches

    private(set) var meds: [MedInfo] = []
    /// Trailing 90-day dose-log window (identifier-matched to slots).
    private(set) var admins: [MedicationAdministration] = []
    private(set) var reviewQueueCount = 0
    private(set) var coreLoadError: String?
    private(set) var coreLoaded = false

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
        client = medplum
        record = RecordAPI(client: medplum)
        ai = AIService(baseURL: aiURL)
        unlocked = !defaults.bool(forKey: "requireBiometrics")
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
        await client.signOut()
        authState = .signedOut
        patient = nil
        meds = []
        admins = []
        coreLoaded = false
        ReminderScheduler.cancelAll()
    }

    /// Rebuild clients after the user edits server URLs in Settings.
    /// Changing the Medplum URL invalidates the session (tokens are bound to
    /// the server that minted them), so this drops back to sign-in.
    func applyServerSettings() async {
        let serverURL = URL(string: serverURLString) ?? URL(string: "http://localhost:8103/")!
        let aiURL = URL(string: aiServiceURLString) ?? URL(string: "http://localhost:8000/")!
        ai = AIService(baseURL: aiURL)
        let rebuilt = MedplumClient(baseURL: serverURL)
        client = rebuilt
        record = RecordAPI(client: rebuilt)
        if await rebuilt.isAuthenticated {
            authState = .signedIn
            await afterSignIn()
        } else {
            authState = .signedOut
        }
    }

    private func afterSignIn() async {
        profileName = (try? await client.profileDisplayName()) ?? "Owner"
        await refreshCore()
    }

    // MARK: Shared data

    /// Load the med list + 90-day dose window + patient — the slot model
    /// Today/Meds/Adherence all share. Safe to call repeatedly (pull to
    /// refresh, after logging a dose).
    func refreshCore() async {
        do {
            patient = try await record.getPatient()
            meds = try await record.loadMeds()
            admins = try await record.loadAdmins(days: 90)
            coreLoadError = nil
            coreLoaded = true
            if remindersEnabled {
                ReminderScheduler.reschedule(meds: meds, showMedName: remindersShowMedName)
            }
        } catch let error as MedplumError {
            if case .unauthenticated = error {
                authState = .signedOut
                return
            }
            coreLoadError = error.localizedDescription
        } catch {
            coreLoadError = error.localizedDescription
        }
        reviewQueueCount = (try? await record.reviewQueueCount()) ?? reviewQueueCount
    }

    /// Log a dose and update the local cache in place so every screen's
    /// slot state flips immediately (the server write is the idempotent
    /// source of truth; the cache patch just avoids a full reload).
    func logDose(slot: DoseSlot, action: DoseAction, takenAt: Date? = nil) async throws {
        guard let patientId = patient?.id else {
            throw MedplumError.invalidResponse("No patient record — run make seed on the server")
        }
        let result = try await record.logDose(patientId: patientId, slot: slot, action: action, takenAt: takenAt)
        if let index = admins.firstIndex(where: { admin in
            admin.identifier?.contains { $0.system == FHIR.administrationIdentSystem && $0.value == slot.identValue } ?? false
        }) {
            admins[index] = result
        } else {
            admins.append(result)
        }
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
