import SwiftUI
import HealMeDailyKit

/// Quick add — manual capture cards, the iOS port of the web LogPage.
///
/// Every card is an independent form: its own fields, its own Save button,
/// its own busy/saved/error state. All FHIR shapes come from the shared
/// `QuickLog` builders (verified codes + plausibility gates live THERE, never
/// here) and every save goes through `RecordAPI.saveQuickObservations`, which
/// stamps the idempotency identifier. Manual entry never touches the AI
/// review queue — that gate is for AI/OCR extractions only.
///
/// Measured data = ink; no AI content on this screen, so no indigo anywhere.
/// Plausibility validation only — deliberately no clinical thresholds or
/// high/low judgments (spec SR-3 deferral).
struct QuickAddView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PageHeader(
                    title: "Quick add",
                    subtitle: "Everything saves straight into your FHIR record with the time you choose — backdating is fine."
                )

                HStack {
                    VaultChip()
                    Spacer(minLength: 0)
                }

                QuickAddWeightCard()
                QuickAddSleepCard()
                QuickAddMoodEnergyCard()
                QuickAddSymptomCard()
                QuickAddVitalsCard()
                QuickAddRxQuestionCard()
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(T.canvas)
        .navigationTitle("Quick add")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Weight

private struct QuickAddWeightCard: View {
    @Environment(AppModel.self) private var model
    @State private var kgText = ""
    @State private var when = Date()
    @State private var busy = false
    @State private var saved = false
    @State private var errorMessage: String?

    var body: some View {
        DsCard {
            QuickAddCardHeader(icon: "scalemass", title: "Weight", note: "kg · backdatable")
            QuickAddNumberField(label: "Weight (kg)", placeholder: "kg", text: $kgText)
            QuickAddWhenPicker(when: $when)
            QuickAddSaveFooter(busy: busy, saved: $saved, errorMessage: errorMessage) { save() }
        }
    }

    private func save() {
        errorMessage = nil
        saved = false
        busy = true
        Task {
            do {
                let observation = try QuickLog.weight(kg: quickAddDouble(kgText) ?? 0, when: when)
                _ = try await model.saveQuickObservations([observation])
                kgText = ""
                when = Date()
                withAnimation { saved = true }
            } catch {
                errorMessage = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Sleep

private struct QuickAddSleepCard: View {
    @Environment(AppModel.self) private var model
    @State private var hoursText = ""
    @State private var when = Date()
    @State private var busy = false
    @State private var saved = false
    @State private var errorMessage: String?

    var body: some View {
        DsCard {
            QuickAddCardHeader(icon: "moon.zzz", title: "Sleep", note: "hours · backdatable")
            QuickAddNumberField(label: "Hours slept", placeholder: "h", text: $hoursText)
            QuickAddWhenPicker(when: $when)
            QuickAddSaveFooter(busy: busy, saved: $saved, errorMessage: errorMessage) { save() }
        }
    }

    private func save() {
        errorMessage = nil
        saved = false
        busy = true
        Task {
            do {
                let observation = try QuickLog.sleep(hours: quickAddDouble(hoursText) ?? 0, when: when)
                _ = try await model.saveQuickObservations([observation])
                hoursText = ""
                when = Date()
                withAnimation { saved = true }
            } catch {
                errorMessage = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Mood & energy

private struct QuickAddMoodEnergyCard: View {
    @Environment(AppModel.self) private var model
    @State private var mood: Double = 5
    @State private var energy: Double = 5
    @State private var when = Date()
    @State private var busy = false
    @State private var saved = false
    @State private var errorMessage: String?

    var body: some View {
        DsCard {
            QuickAddCardHeader(icon: "face.smiling", title: "Mood & energy", note: "1–10 · backdatable")
            QuickAddSliderRow(label: "Mood", value: $mood)
            QuickAddSliderRow(label: "Energy", value: $energy)
            QuickAddWhenPicker(when: $when)
            QuickAddSaveFooter(busy: busy, saved: $saved, errorMessage: errorMessage) { save() }
        }
    }

    private func save() {
        errorMessage = nil
        saved = false
        busy = true
        Task {
            do {
                // Returns two Observations (mood + energy) — pass the array through.
                let observations = QuickLog.moodEnergy(mood: Int(mood), energy: Int(energy), when: when)
                _ = try await model.saveQuickObservations(observations)
                mood = 5
                energy = 5
                when = Date()
                withAnimation { saved = true }
            } catch {
                errorMessage = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Symptom / side effect

private struct QuickAddSymptomCard: View {
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var when = Date()
    @State private var busy = false
    @State private var saved = false
    @State private var errorMessage: String?

    var body: some View {
        DsCard {
            QuickAddCardHeader(icon: "bandage", title: "Symptom / side effect", note: "free text · backdatable")
            VStack(alignment: .leading, spacing: 6) {
                FieldLabel(text: "What happened")
                TextField(
                    "",
                    text: $text,
                    prompt: Text("e.g. mild headache after lunch")
                )
                .textFieldStyle(BandFieldStyle())
            }
            QuickAddWhenPicker(when: $when)
            QuickAddSaveFooter(busy: busy, saved: $saved, errorMessage: errorMessage) { save() }
        }
    }

    private func save() {
        errorMessage = nil
        saved = false
        busy = true
        Task {
            do {
                let observation = try QuickLog.symptom(text: text, when: when)
                _ = try await model.saveQuickObservations([observation])
                text = ""
                when = Date()
                withAnimation { saved = true }
            } catch {
                errorMessage = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Vitals

private struct QuickAddVitalsCard: View {
    @Environment(AppModel.self) private var model
    @State private var systolic = ""
    @State private var diastolic = ""
    @State private var heartRate = ""
    @State private var temperature = ""
    @State private var spo2 = ""
    @State private var glucose = ""
    @State private var when = Date()
    @State private var busy = false
    @State private var saved = false
    @State private var errorMessage: String?

    private let columns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
    ]

    var body: some View {
        DsCard {
            QuickAddCardHeader(
                icon: "waveform.path.ecg",
                title: "Vitals",
                note: "backdatable · plausibility check only"
            )
            LazyVGrid(columns: columns, alignment: .leading, spacing: 12) {
                QuickAddNumberField(label: rangeLabel(0), placeholder: rangeHint(0), text: $systolic)
                QuickAddNumberField(label: rangeLabel(1), placeholder: rangeHint(1), text: $diastolic)
                QuickAddNumberField(label: rangeLabel(2), placeholder: rangeHint(2), text: $heartRate)
                QuickAddNumberField(label: rangeLabel(3), placeholder: rangeHint(3), text: $temperature)
                QuickAddNumberField(label: rangeLabel(4), placeholder: rangeHint(4), text: $spo2)
                QuickAddNumberField(label: rangeLabel(5), placeholder: rangeHint(5), text: $glucose)
            }
            QuickAddWhenPicker(when: $when)
            QuickAddSaveFooter(busy: busy, saved: $saved, errorMessage: errorMessage) { save() }
        }
    }

    /// Labels and plausible-entry windows come straight from
    /// `QuickLog.vitalsRanges` — never restate ranges here.
    private func rangeLabel(_ index: Int) -> String {
        QuickLog.vitalsRanges[index].label
    }

    private func rangeHint(_ index: Int) -> String {
        let range = QuickLog.vitalsRanges[index].range
        return "\(Int(range.lowerBound))–\(Int(range.upperBound))"
    }

    private func save() {
        errorMessage = nil
        saved = false
        busy = true
        Task {
            do {
                let entry = QuickLog.VitalsEntry(
                    systolic: quickAddDouble(systolic),
                    diastolic: quickAddDouble(diastolic),
                    heartRate: quickAddDouble(heartRate),
                    temperature: quickAddDouble(temperature),
                    spo2: quickAddDouble(spo2),
                    glucose: quickAddDouble(glucose)
                )
                // Throws with a precise message (e.g. lone systolic) — surface verbatim.
                let observations = try QuickLog.vitals(entry, when: when)
                _ = try await model.saveQuickObservations(observations)
                systolic = ""
                diastolic = ""
                heartRate = ""
                temperature = ""
                spo2 = ""
                glucose = ""
                when = Date()
                withAnimation { saved = true }
            } catch {
                errorMessage = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Question for your clinician

private struct QuickAddRxQuestionCard: View {
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var busy = false
    @State private var saved = false
    @State private var errorMessage: String?

    var body: some View {
        DsCard {
            // No DatePicker: the ask-time is now (QuickLog.rxQuestion stamps it).
            QuickAddCardHeader(
                icon: "questionmark.bubble",
                title: "Question for your clinician",
                note: "time = now · shows in Health Review"
            )
            VStack(alignment: .leading, spacing: 6) {
                FieldLabel(text: "Your question")
                TextField(
                    "",
                    text: $text,
                    prompt: Text("e.g. should we revisit the evening dose timing?")
                )
                .textFieldStyle(BandFieldStyle())
            }
            QuickAddSaveFooter(busy: busy, saved: $saved, errorMessage: errorMessage) { save() }
        }
    }

    private func save() {
        errorMessage = nil
        saved = false
        busy = true
        Task {
            do {
                let observation = try QuickLog.rxQuestion(text: text)
                _ = try await model.saveQuickObservations([observation])
                text = ""
                withAnimation { saved = true }
            } catch {
                errorMessage = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Shared card bits (Quick add only — DS primitives stay in Components.swift)

/// SF Symbol in a 34pt band-background rounded square + semibold title +
/// mono sub note (the "kg · backdatable" line).
private struct QuickAddCardHeader: View {
    let icon: String
    let title: String
    let note: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.ui(15, weight: .medium))
                .foregroundStyle(T.secondary)
                // min sizes: tile grows with the Dynamic Type-scaled icon.
                .frame(minWidth: 34, minHeight: 34)
                .background(T.band, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.ui(15, weight: .semibold))
                    .foregroundStyle(T.ink)
                Text(note)
                    .font(.mono(10))
                    .foregroundStyle(T.tertiary)
            }
            Spacer(minLength: 0)
        }
    }
}

/// Labeled decimal-pad field; placeholder is mono (it shows numbers/units).
private struct QuickAddNumberField: View {
    let label: String
    let placeholder: String
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FieldLabel(text: label)
            TextField(
                "",
                text: $text,
                prompt: Text(placeholder).font(.mono(13)).foregroundStyle(T.quaternary)
            )
            .textFieldStyle(BandFieldStyle())
            .keyboardType(.decimalPad)
        }
    }
}

/// Backdatable clinical-time picker — defaults to now, never allows a future
/// time. 24h clock per owner preference (locale override keeps it fixed).
private struct QuickAddWhenPicker: View {
    @Binding var when: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FieldLabel(text: "When")
            DatePicker(
                "",
                selection: $when,
                in: ...Date(),
                displayedComponents: [.date, .hourAndMinute]
            )
            .labelsHidden()
            .datePickerStyle(.compact)
            .environment(\.locale, Locale(identifier: "en_GB"))
            .tint(T.green)
        }
    }
}

/// 1–10 slider with the current value in mono (numbers are always mono).
private struct QuickAddSliderRow: View {
    let label: String
    @Binding var value: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                FieldLabel(text: label)
                Spacer(minLength: 0)
                Text("\(Int(value))/10")
                    .font(.mono(13, weight: .medium))
                    .foregroundStyle(T.ink)
            }
            Slider(value: $value, in: 1 ... 10, step: 1)
                .tint(T.green)
        }
    }
}

/// Per-card footer: error banner + Save button + transient "Saved ✓"
/// (green mono, auto-hides after 2s).
private struct QuickAddSaveFooter: View {
    var title = "Save"
    let busy: Bool
    @Binding var saved: Bool
    let errorMessage: String?
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let errorMessage {
                ErrorBanner(message: errorMessage)
            }
            PillButton(title: title, busy: busy, action: action)
            if saved {
                Text("Saved ✓")
                    .font(.mono(12, weight: .medium))
                    .foregroundStyle(T.green)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .transition(.opacity)
                    .task {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        withAnimation { saved = false }
                    }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// Lenient decimal parse for decimal-pad input (accepts "," as the decimal
/// separator some locales produce). nil/0 falls through to the builders'
/// own validation messages.
private func quickAddDouble(_ text: String) -> Double? {
    Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "."))
}
