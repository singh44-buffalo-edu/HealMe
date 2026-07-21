import AVFoundation
import Foundation
import Speech

/// On-device dictation for the momentary feeling sheet.
///
/// Privacy contract (the app's standing promise: nothing leaves the device
/// unless the owner routes it somewhere): `requiresOnDeviceRecognition` is
/// ALWAYS true — audio and transcript are processed by the iPhone's local
/// speech model and never sent to Apple or anyone else. When on-device
/// recognition is not available for the current locale the state becomes
/// `.unavailable` and the UI says so and falls back to typing; we NEVER
/// silently downgrade to server-based recognition.
///
/// Session shape: partial results stream into `transcript` while recording;
/// recording stops on the user's tap, after ~2.5s of silence following
/// speech, or at a 60s hard cap — whichever comes first.
@MainActor
@Observable
final class SpeechDictation {
    enum State: Equatable {
        case idle
        /// Mic or speech-recognition permission refused (iOS Settings fixes it).
        case denied
        /// No on-device model for this locale — typing is the only path.
        case unavailable
        case recording
    }

    private(set) var state: State = .idle
    /// Live transcript of the CURRENT recording (grows as partials stream in).
    private(set) var transcript = ""
    private(set) var errorMessage: String?

    @ObservationIgnored private let audioEngine = AVAudioEngine()
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var hardStopTask: _Concurrency.Task<Void, Never>?
    @ObservationIgnored private var silenceTask: _Concurrency.Task<Void, Never>?

    /// Hard cap per recording — a forgotten live mic must always end itself.
    private static let maxSeconds: UInt64 = 60
    /// Auto-stop after this much silence once the user has said something.
    private static let silenceSeconds: Double = 2.5

    func startDictation() async {
        guard state != .recording else { return }
        errorMessage = nil
        transcript = ""

        // Permissions first (system prompts on first use; both must be
        // granted — the mic feeds the recognizer).
        let speechAuth = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speechAuth == .authorized else {
            state = .denied
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            state = .denied
            return
        }

        // On-device or nothing: no model for this locale ⇒ .unavailable,
        // never a silent switch to Apple's servers.
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(),
              recognizer.isAvailable, recognizer.supportsOnDeviceRecognition
        else {
            state = .unavailable
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true // NON-NEGOTIABLE — see header
        request.shouldReportPartialResults = true
        self.request = request

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let inputNode = audioEngine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            cleanUpAudio()
            state = .idle
            errorMessage = "Could not start the microphone: \(error.localizedDescription)"
            return
        }

        state = .recording
        armHardStop()

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            // The recognizer calls back on an arbitrary queue — hop home.
            _Concurrency.Task { @MainActor [weak self] in
                guard let self, self.state == .recording else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    // Speech happened — (re)arm the silence auto-stop.
                    if !self.transcript.isEmpty {
                        self.armSilenceStop()
                    }
                    if result.isFinal {
                        self.stopDictation()
                        return
                    }
                }
                if error != nil {
                    // Treat a mid-stream failure as end-of-dictation: whatever
                    // was transcribed stays in the note; no partial loss.
                    self.stopDictation()
                }
            }
        }
    }

    /// Stop and keep whatever was transcribed (button tap, silence, 60s cap,
    /// sheet dismissal — every path lands here; safe to call repeatedly).
    func stopDictation() {
        guard state == .recording else { return }
        state = .idle
        cleanUpAudio()
    }

    private func cleanUpAudio() {
        hardStopTask?.cancel()
        hardStopTask = nil
        silenceTask?.cancel()
        silenceTask = nil
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func armHardStop() {
        hardStopTask?.cancel()
        hardStopTask = _Concurrency.Task { [weak self] in
            try? await _Concurrency.Task.sleep(nanoseconds: Self.maxSeconds * 1_000_000_000)
            guard !_Concurrency.Task.isCancelled else { return }
            self?.stopDictation()
        }
    }

    private func armSilenceStop() {
        silenceTask?.cancel()
        silenceTask = _Concurrency.Task { [weak self] in
            try? await _Concurrency.Task.sleep(nanoseconds: UInt64(Self.silenceSeconds * 1_000_000_000))
            guard !_Concurrency.Task.isCancelled else { return }
            self?.stopDictation()
        }
    }
}
