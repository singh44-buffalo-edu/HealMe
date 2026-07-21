import SwiftUI
import HealMeDailyKit

/// Read-only medication list. Med configuration (schedules, life-critical
/// flag, cartridge assignment) deliberately lives ONLY in the web app — this
/// screen displays the shared `AppModel.meds` cache and never writes.
///
/// Medical-safety notes (owner-approved rules):
/// - `lifeCritical` gets display prominence only (red dot + eyebrow) — no
///   dose logic hangs off it here.
/// - The cartridge block is inventory DISPLAY only; stock level never gates
///   whether a med may be taken, so nothing here disables or warns beyond
///   the low-stock tag the web app also shows.
struct MedsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    PageHeader(title: "Medications", subtitle: "\(model.meds.count) active")
                    VaultChip()
                }

                if let error = model.coreLoadError {
                    ErrorBanner(message: error)
                }

                if !model.coreLoaded && model.meds.isEmpty {
                    ProgressView()
                        .tint(T.green)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 32)
                } else if model.meds.isEmpty {
                    DsCard {
                        EmptyNote(text: "No active medications — add them in the web app.")
                    }
                } else {
                    ForEach(model.meds, id: \.self) { med in
                        MedCard(med: med)
                    }
                }

                Text("Medication setup & cartridge config live in the web app.")
                    .font(.mono(10))
                    .foregroundStyle(T.quaternary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(16)
        }
        .background(T.canvas)
        .navigationTitle("Meds")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await model.refreshCore()
        }
    }
}

// MARK: - One medication

private struct MedCard: View {
    let med: MedInfo

    var body: some View {
        DsCard {
            // Name row — life-critical meds get a red status dot + eyebrow
            // tag (prominence only; status color on the dot, never the card).
            HStack(spacing: 8) {
                if med.lifeCritical {
                    StatusDot(color: T.outOfRange)
                }
                Text(med.name)
                    .font(.ui(16, weight: .semibold))
                    .foregroundStyle(T.ink)
                Spacer(minLength: 8)
                if med.lifeCritical {
                    Eyebrow(text: "Life-critical", color: T.outOfRange)
                }
            }

            // SIG instructions — prose, so NOT mono.
            if !med.instructions.isEmpty {
                Text(med.instructions)
                    .font(.ui(12.5))
                    .foregroundStyle(T.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Scheduled times — data voice: mono chips, 24h clock.
            if !med.times.isEmpty {
                HStack(spacing: 6) {
                    ForEach(med.times, id: \.self) { time in
                        Chip(text: Fmt.hhmm(time))
                    }
                }
            }

            if !med.startDate.isEmpty {
                Text("since \(med.startDate)")
                    .font(.mono(10))
                    .foregroundStyle(T.quaternary)
            }

            if let cartridge = med.cartridge {
                // Hairline divider — allowed INSIDE cards only.
                Rectangle()
                    .fill(T.hairline)
                    .frame(height: 1)
                CartridgeBlock(cartridge: cartridge)
            }
        }
    }
}

// MARK: - Cartridge inventory (display only — never gates a dose)

private struct CartridgeBlock: View {
    let cartridge: CartridgeInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Eyebrow(text: "Cartridge")
                Spacer(minLength: 8)
                if cartridge.low {
                    HStack(spacing: 5) {
                        StatusDot(color: T.watch, size: 6)
                        Text("LOW")
                            .font(.mono(10, weight: .semibold))
                            .foregroundStyle(T.watch)
                    }
                }
            }

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(cartridge.name)
                    .font(.ui(13))
                    .foregroundStyle(T.ink)
                Spacer(minLength: 8)
                if let remaining = cartridge.remaining, let capacity = cartridge.capacity {
                    Text("\(Fmt.number(remaining)) / \(Fmt.number(capacity))")
                        .font(.mono(12, weight: .medium))
                        .foregroundStyle(T.ink)
                }
            }

            if let remaining = cartridge.remaining,
               let capacity = cartridge.capacity,
               capacity > 0 {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(T.band)
                        Capsule()
                            .fill(cartridge.low ? T.watch : T.green)
                            .frame(width: geo.size.width * min(max(remaining / capacity, 0), 1))
                    }
                }
                .frame(height: 5)
            }
        }
    }
}
