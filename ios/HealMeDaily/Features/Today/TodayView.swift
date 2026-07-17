import SwiftUI
import HealMeDailyKit

/// Today tab — the dose panel. Renders every dose slot the schedule expects
/// for the current LOCAL calendar day, matched against the shared 90-day
/// dose-log cache, plus due check-ins and open follow-up tasks.
///
/// Medical-safety notes (owner-approved rules, ported from the web app):
/// - "No log ⇒ no resource": DUE/OVERDUE are DISPLAY urgency only, computed
///   from elapsed time each minute — crossing the grace threshold never
///   writes anything. Only an explicit tap calls `model.logDose`.
/// - Corrections (taken↔skipped↔missed) re-log the SAME logical event via
///   the slot identifier; the engine converges on one MedicationAdministration.
/// - Life-critical flags get display prominence only (sort-first + red
///   eyebrow on overdue) — no dose logic hangs off them.
/// - Backdating is supported (DatePicker capped at now, never future).
struct TodayView: View {
    @Environment(AppModel.self) private var model

    @State private var checkins: [CheckinDef] = []
    @State private var checkinsLoaded = false
    @State private var followUps: [FHIRTask] = []
    @State private var errorMessage: String?
    @State private var busySlotIdents: Set<String> = []
    @State private var busyTaskIds: Set<String> = []
    @State private var backdateTarget: TodayBackdateTarget?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    PageHeader(title: "Today", subtitle: Fmt.when(DoseEngine.localDateString(Date())))
                    VaultChip()
                }

                if let error = model.coreLoadError {
                    ErrorBanner(message: error)
                }
                if let error = errorMessage {
                    ErrorBanner(message: error)
                }

                syncStrip

                if !model.coreLoaded {
                    ProgressView()
                        .tint(T.green)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 48)
                } else {
                    // everyMinute keeps DUE/OVERDUE tags (and the midnight
                    // day rollover) fresh — a pure re-render, never a write.
                    TimelineView(.everyMinute) { context in
                        doseSection(now: context.date)
                    }

                    checkinsCard

                    if !followUps.isEmpty {
                        followUpsCard
                    }

                    // No AI on this screen, so no DisclaimerFooter — instead
                    // the standing statement of the no-log-no-record rule.
                    Text("No log means no record — only your explicit taps write dose events.")
                        .font(.mono(10))
                        .foregroundStyle(T.quaternary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 2)
                }
            }
            .padding(16)
        }
        .background(T.canvas)
        .navigationTitle("Today")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if !model.coreLoaded {
                await model.refreshCore()
            }
            await loadSecondary()
        }
        .refreshable {
            await model.refreshCore()
            await loadSecondary()
        }
        .sheet(item: $backdateTarget) { target in
            TodayBackdateSheet(slot: target.slot) { takenAt in
                log(target.slot, .taken, takenAt: takenAt)
            }
        }
    }

    // MARK: - Offline / sync state

    /// Offline + outbox status. Factual device-state notes (not errors):
    /// what's shown, why, and what happens when connectivity returns.
    @ViewBuilder
    private var syncStrip: some View {
        if model.isOffline || model.pendingWrites > 0 || model.usingCachedCore {
            DsCard(padding: 12) {
                HStack(spacing: 8) {
                    StatusDot(color: T.watch, size: 6)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.isOffline ? "Offline" : "Syncing")
                            .font(.mono(10, weight: .semibold))
                            .kerning(0.8)
                            .foregroundStyle(T.watch)
                        if model.usingCachedCore {
                            Text("Showing the last copy saved on this device.")
                                .font(.system(size: 12))
                                .foregroundStyle(T.secondary)
                        }
                        if model.pendingWrites > 0 {
                            Text("\(model.pendingWrites) change\(model.pendingWrites == 1 ? "" : "s") saved here — syncs when your server is reachable.")
                                .font(.system(size: 12))
                                .foregroundStyle(T.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        if !model.syncFailures.isEmpty {
            // Server rejected queued writes — dropped from the queue, shown
            // loudly so nothing disappears silently.
            DsCard(padding: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Some offline changes could not sync")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(T.outOfRange)
                    ForEach(model.syncFailures, id: \.self) { failure in
                        Text(failure)
                            .font(.mono(11))
                            .foregroundStyle(T.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    PillButton(title: "Dismiss", variant: .secondary) {
                        model.dismissSyncFailures()
                    }
                }
            }
        }
    }

    // MARK: - Dose slots

    @ViewBuilder
    private func doseSection(now: Date) -> some View {
        let rows = slotRows(now: now)
        VStack(alignment: .leading, spacing: 12) {
            Eyebrow(text: "Doses")
            if rows.isEmpty {
                DsCard {
                    EmptyNote(text: "No doses scheduled today")
                }
            } else {
                ForEach(rows, id: \.slot.identValue) { row in
                    doseCard(row)
                }
            }
        }
    }

    @ViewBuilder
    private func doseCard(_ row: TodaySlotRow) -> some View {
        let busy = busySlotIdents.contains(row.slot.identValue)
        let card = DsCard(padding: 16) {
            // Overdue life-critical flag — display prominence only.
            if row.isOverdueLifeCritical {
                Eyebrow(text: "Life-critical", color: T.outOfRange)
            }

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.slot.med.name)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(T.ink)
                Spacer(minLength: 8)
                Text(Fmt.hhmm(row.slot.time))
                    .font(.mono(13, weight: .medium))
                    .foregroundStyle(T.ink)
            }

            // SIG instructions — prose, so NOT mono.
            if !row.slot.med.instructions.isEmpty {
                Text(row.slot.med.instructions)
                    .font(.system(size: 12))
                    .foregroundStyle(T.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Inventory display only — never gates whether a med may be taken.
            if let cartridge = row.slot.med.cartridge, let remaining = cartridge.remaining {
                Text("\(Fmt.number(remaining)) left")
                    .font(.mono(11))
                    .foregroundStyle(cartridge.low ? T.watch : T.tertiary)
            }

            stateRow(row, busy: busy)

            // This slot's state is a local echo of a queued write.
            if model.pendingDoseIdents.contains(row.slot.identValue) {
                Text("Saved on this device — pending sync")
                    .font(.mono(10))
                    .foregroundStyle(T.watch)
            }
        }
        // Correcting a taken dose re-logs the same logical event.
        if case .taken = row.state {
            card.contextMenu {
                Button("Skip") { log(row.slot, .skipped) }
                Button("Mark missed") { log(row.slot, .missed) }
            }
        } else {
            card
        }
    }

    @ViewBuilder
    private func stateRow(_ row: TodaySlotRow, busy: Bool) -> some View {
        switch row.state {
        case .taken(let when):
            HStack(spacing: 7) {
                StatusDot(color: T.green)
                Text("Taken")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(T.green)
                if !when.isEmpty {
                    Text(Fmt.when(when))
                        .font(.mono(11))
                        .foregroundStyle(T.secondary)
                }
                Spacer(minLength: 0)
            }
        case .skipped:
            notDoneRow(row, word: "Skipped", color: T.watch, busy: busy)
        case .missed:
            notDoneRow(row, word: "Missed", color: T.outOfRange, busy: busy)
        case .upcoming:
            unloggedRow(row, busy: busy) {
                Text("Upcoming")
                    .font(.mono(10, weight: .medium))
                    .kerning(0.6)
                    .foregroundStyle(T.quaternary)
            }
        case .due:
            unloggedRow(row, busy: busy) {
                HStack(spacing: 6) {
                    StatusDot(color: T.watch, size: 6)
                    Text("DUE")
                        .font(.mono(10, weight: .semibold))
                        .kerning(0.8)
                        .foregroundStyle(T.watch)
                }
            }
        case .overdue:
            unloggedRow(row, busy: busy) {
                HStack(spacing: 6) {
                    StatusDot(color: T.outOfRange, size: 6)
                    Text("OVERDUE")
                        .font(.mono(10, weight: .semibold))
                        .kerning(0.8)
                        .foregroundStyle(T.outOfRange)
                }
            }
        }
    }

    /// Skipped/missed — status color on dot + word only; the same logical
    /// event stays correctable ("Take now" updates it in place).
    private func notDoneRow(_ row: TodaySlotRow, word: String, color: Color, busy: Bool) -> some View {
        HStack(spacing: 7) {
            StatusDot(color: color)
            Text(word)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(color)
            Spacer(minLength: 8)
            TodaySmallPill(title: "Take now", busy: busy) {
                log(row.slot, .taken)
            }
        }
    }

    private func unloggedRow<Tag: View>(
        _ row: TodaySlotRow,
        busy: Bool,
        @ViewBuilder tag: () -> Tag
    ) -> some View {
        HStack(spacing: 8) {
            tag()
            Spacer(minLength: 8)
            TodaySmallPill(title: "Take", busy: busy) {
                log(row.slot, .taken)
            }
            Menu {
                Button("Take at earlier time…") {
                    backdateTarget = TodayBackdateTarget(slot: row.slot)
                }
                Button("Skip") { log(row.slot, .skipped) }
                Button("Mark missed") { log(row.slot, .missed) }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 20))
                    .foregroundStyle(T.secondary)
                    .frame(width: 40, height: 40)
                    .contentShape(Rectangle())
            }
            .disabled(busy)
        }
    }

    // MARK: - Slot model

    private func slotRows(now: Date) -> [TodaySlotRow] {
        let slots = DoseEngine.slotsForDate(model.meds, date: DoseEngine.localDateString(now))
        let rows = slots.map { TodaySlotRow(slot: $0, state: state(for: $0, now: now)) }
        // Time order, except overdue gaps surface first — and among those,
        // life-critical meds first (CLAUDE.md: critical gaps sort first).
        return rows.sorted { a, b in
            if a.priority != b.priority { return a.priority < b.priority }
            return a.slot.time < b.slot.time
        }
    }

    private func state(for slot: DoseSlot, now: Date) -> TodaySlotState {
        if let admin = DoseEngine.adminForSlot(model.admins, slot) {
            if admin.status == "completed" {
                return .taken(when: admin.effectiveDateTime ?? "")
            }
            let codes = admin.statusReason?.flatMap { $0.coding ?? [] }.compactMap(\.code) ?? []
            return codes.contains("user-marked-missed") ? .missed : .skipped
        }
        // Unlogged — a real state, not an error. Urgency is display-only.
        if now < slot.scheduled {
            return .upcoming
        }
        let grace = slot.scheduled.addingTimeInterval(TimeInterval(DoseEngine.overdueGraceMinutes * 60))
        return now <= grace ? .due : .overdue
    }

    // MARK: - Check-ins

    private var checkinsCard: some View {
        let due = checkins.filter(\.isDue)
        return DsCard {
            HStack(spacing: 8) {
                Eyebrow(text: "Check-ins")
                Spacer(minLength: 8)
                if !checkinsLoaded {
                    ProgressView()
                        .controlSize(.small)
                        .tint(T.green)
                } else if due.isEmpty {
                    Text("All caught up")
                        .font(.mono(10))
                        .foregroundStyle(T.tertiary)
                } else {
                    Text("\(due.count) due")
                        .font(.mono(10, weight: .semibold))
                        .foregroundStyle(T.watch)
                }
            }

            if checkinsLoaded && !due.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(due.enumerated()), id: \.element.periodIdent) { index, def in
                        if index > 0 {
                            Rectangle()
                                .fill(T.hairline)
                                .frame(height: 1)
                        }
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(def.questionnaire.title ?? "Check-in")
                                    .font(.system(size: 13.5, weight: .medium))
                                    .foregroundStyle(T.ink)
                                Text(def.cadence.label)
                                    .font(.mono(10))
                                    .foregroundStyle(T.tertiary)
                            }
                            Spacer(minLength: 8)
                            Text("DUE")
                                .font(.mono(10, weight: .semibold))
                                .kerning(0.8)
                                .foregroundStyle(T.watch)
                        }
                        .padding(.vertical, 10)
                    }
                }
            }

            NavigationLink {
                CheckinsView()
            } label: {
                HStack(spacing: 4) {
                    Text("Open check-ins")
                        .font(.system(size: 13.5, weight: .semibold))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                }
                .foregroundStyle(T.green)
            }
        }
    }

    // MARK: - Follow-ups (display-only workflow — resolution is the user's tap)

    private var followUpsCard: some View {
        DsCard {
            Eyebrow(text: "Follow-ups")
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(followUps.enumerated()), id: \.element.id) { index, task in
                    if index > 0 {
                        Rectangle()
                            .fill(T.hairline)
                            .frame(height: 1)
                    }
                    HStack(alignment: .center, spacing: 12) {
                        Text(task.description ?? "Follow-up")
                            .font(.system(size: 13))
                            .foregroundStyle(T.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        TodaySmallPill(
                            title: "Done",
                            variant: .secondary,
                            busy: busyTaskIds.contains(task.id ?? "")
                        ) {
                            complete(task)
                        }
                    }
                    .padding(.vertical, 10)
                }
            }
        }
    }

    // MARK: - Actions

    /// The ONLY path that writes dose events — always an explicit user tap.
    private func log(_ slot: DoseSlot, _ action: DoseAction, takenAt: Date? = nil) {
        guard !busySlotIdents.contains(slot.identValue) else { return }
        busySlotIdents.insert(slot.identValue)
        Task { @MainActor in
            defer { busySlotIdents.remove(slot.identValue) }
            do {
                try await model.logDose(slot: slot, action: action, takenAt: takenAt)
                errorMessage = nil
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func complete(_ task: FHIRTask) {
        guard let id = task.id, !busyTaskIds.contains(id) else { return }
        busyTaskIds.insert(id)
        Task { @MainActor in
            defer { busyTaskIds.remove(id) }
            do {
                try await model.record.completeFollowUp(task)
                followUps = try await model.record.loadFollowUps()
                errorMessage = nil
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func loadSecondary() async {
        do {
            checkins = try await model.record.loadCheckins()
            followUps = try await model.record.loadFollowUps()
            checkinsLoaded = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Slot presentation model

private enum TodaySlotState {
    case taken(when: String)
    case skipped
    case missed
    case upcoming
    case due
    case overdue
}

private struct TodaySlotRow {
    var slot: DoseSlot
    var state: TodaySlotState

    /// Sort bucket: overdue life-critical → overdue → everything else (time
    /// order within each bucket).
    var priority: Int {
        guard case .overdue = state else { return 2 }
        return slot.med.lifeCritical ? 0 : 1
    }

    var isOverdueLifeCritical: Bool {
        if case .overdue = state { return slot.med.lifeCritical }
        return false
    }
}

// MARK: - Small pill (row-scale action; PillButton is full-width)

private struct TodaySmallPill: View {
    enum Variant {
        case primary, secondary
    }

    let title: String
    var variant: Variant = .primary
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(variant == .primary ? .white : T.ink)
                .padding(.horizontal, 14)
                .frame(minHeight: 34)
                .background(variant == .primary ? T.green : T.chip, in: Capsule())
                .frame(minHeight: 44) // 44pt hit target around the smaller pill
                .contentShape(Rectangle())
        }
        .disabled(busy)
        .opacity(busy ? 0.45 : 1)
    }
}

// MARK: - Backdate sheet ("Take at earlier time…")

private struct TodayBackdateTarget: Identifiable {
    let slot: DoseSlot
    var id: String { slot.identValue }
}

private struct TodayBackdateSheet: View {
    let slot: DoseSlot
    let onLog: (Date) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var takenAt = Date()

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(slot.med.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(T.ink)
                    Spacer(minLength: 8)
                    Text("\(String(slot.date)) \(Fmt.hhmm(slot.time))")
                        .font(.mono(12))
                        .foregroundStyle(T.secondary)
                }

                FieldLabel(text: "Taken at")
                // Backdating only — never a future time.
                DatePicker(
                    "Taken at",
                    selection: $takenAt,
                    in: ...Date(),
                    displayedComponents: [.date, .hourAndMinute]
                )
                .labelsHidden()
                .tint(T.green)

                Spacer(minLength: 0)

                PillButton(title: "Log as taken") {
                    onLog(takenAt)
                    dismiss()
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(T.canvas)
            .navigationTitle("Take at earlier time")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}
