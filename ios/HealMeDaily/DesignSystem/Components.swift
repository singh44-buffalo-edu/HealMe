import SwiftUI
import HealMeDailyKit

/// SwiftUI ports of the web design-system primitives in
/// `frontend/src/components/ds.tsx`. Extend HERE, don't fork styles in
/// feature views — the three-data-classes rules live in these components.

// MARK: - Card

/// Borderless card on soft shadow (hairline dividers inside only — never a
/// card border). `ai: true` swaps to the indigo-tinted AI shadow.
struct DsCard<Content: View>: View {
    var padding: CGFloat = 18
    var ai = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(padding)
        .background(T.card)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .shadow(color: (ai ? T.ai : Color.black).opacity(0.05), radius: 14, y: 8)
        .shadow(color: (ai ? T.ai : Color.black).opacity(0.04), radius: 1, y: 1)
    }
}

// MARK: - Text primitives

/// Uppercase mono eyebrow label above a section.
struct Eyebrow: View {
    let text: String
    var color: Color = T.quaternary

    var body: some View {
        Text(text.uppercased())
            .font(.mono(10, weight: .medium))
            .kerning(1.0)
            .foregroundStyle(color)
    }
}

struct PageHeader: View {
    let title: String
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(T.ink)
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 12.5))
                    .foregroundStyle(T.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Dots & pills

/// Small status dot. `pulsing` is reserved for LIVE DEVICE data (green
/// class) — never decorate static values with it.
struct StatusDot: View {
    let color: Color
    var size: CGFloat = 7
    var pulsing = false
    @State private var pulse = false

    // Explicit init: the private @State would otherwise make the synthesized
    // memberwise init private, breaking every cross-file StatusDot(color:).
    init(color: Color, size: CGFloat = 7, pulsing: Bool = false) {
        self.color = color
        self.size = size
        self.pulsing = pulsing
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .overlay {
                if pulsing {
                    Circle()
                        .stroke(color.opacity(pulse ? 0 : 0.6), lineWidth: 2)
                        .scaleEffect(pulse ? 2.2 : 1)
                        .animation(.easeOut(duration: 1.4).repeatForever(autoreverses: false), value: pulse)
                }
            }
            .onAppear { pulse = pulsing }
    }
}

/// The ✦ AI pill — MANDATORY on every AI-derived surface (three-data-classes
/// rule). AI output is never rendered unlabeled.
struct AIPill: View {
    var text = "AI"

    var body: some View {
        Text("✦ \(text)")
            .font(.mono(10, weight: .medium))
            .foregroundStyle(T.ai)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(T.aiBg, in: Capsule())
    }
}

struct Chip: View {
    let text: String
    var ai = false

    var body: some View {
        Text(text)
            .font(.mono(10))
            .foregroundStyle(ai ? T.ai : T.tertiary)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(ai ? T.aiBg : T.chip, in: Capsule())
    }
}

/// The privacy-promise chip, present on every surface. On iOS the record
/// lives on the user's own self-hosted server, not this device — the label
/// says exactly that (no false "on this device" claim).
struct VaultChip: View {
    var body: some View {
        HStack(spacing: 6) {
            StatusDot(color: T.green, size: 6)
            Text("Private · your own server")
                .font(.mono(10, weight: .medium))
                .foregroundStyle(T.green)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(T.greenTint, in: Capsule())
    }
}

/// Cloud data boundary — ALWAYS amber and ALWAYS names the recipient
/// (design rule: cloud boundaries are never implicit).
struct BoundaryRow: View {
    let recipient: String

    var body: some View {
        HStack(spacing: 8) {
            StatusDot(color: T.watch, size: 6)
            Text("Data incl. record contents leaves your machine → \(recipient)")
                .font(.mono(10))
                .foregroundStyle(T.watch)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.watch.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

// MARK: - Buttons

struct PillButton: View {
    enum Variant {
        case primary, secondary, destructive, ai
    }

    let title: String
    var variant: Variant = .primary
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if busy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(foreground)
                }
                Text(busy ? "Working…" : title)
                    .font(.system(size: 13.5, weight: .semibold))
            }
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 46) // design min hit target 44pt
            .background(background, in: Capsule())
        }
        .disabled(busy)
    }

    private var foreground: Color {
        switch variant {
        case .primary: return .white
        case .secondary: return T.ink
        case .destructive: return T.outOfRange
        case .ai: return .white
        }
    }

    private var background: Color {
        switch variant {
        case .primary: return T.green
        case .secondary: return T.chip
        case .destructive: return T.destructiveTint
        case .ai: return T.ai
        }
    }
}

// MARK: - States

struct ErrorBanner: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            StatusDot(color: T.outOfRange, size: 7)
                .padding(.top, 4)
            Text(message)
                .font(.system(size: 12.5))
                .foregroundStyle(T.ink)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.destructiveTint, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct EmptyNote: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.mono(11))
            .foregroundStyle(T.quaternary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 24)
    }
}

/// The standing footer disclaimer (AI guardrail — CLAUDE.md §6).
struct DisclaimerFooter: View {
    var body: some View {
        Text("Not medical advice — a personal record & discussion aid; review with a qualified clinician.")
            .font(.system(size: 11))
            .foregroundStyle(T.quaternary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Form bits shared by capture screens

struct FieldLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.mono(10, weight: .medium))
            .kerning(0.4)
            .foregroundStyle(T.quaternary)
    }
}

/// Band-background text field matching the web input language.
struct BandFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .padding(.horizontal, 12)
            .frame(minHeight: 46)
            .background(T.band, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .font(.system(size: 14))
            .foregroundStyle(T.ink)
    }
}

// MARK: - Formatting helpers

enum Fmt {
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// ISO timestamp → "Jul 14 07:05" in LOCAL time (year only when not current).
    static func when(_ iso: String) -> String {
        let hasTime = iso.count >= 16
        let date: Date?
        if hasTime {
            date = RecordAPI.parseInstant(iso) ?? localDay(String(iso.prefix(10)))
        } else {
            date = localDay(String(iso.prefix(10)))
        }
        guard let date else { return iso }
        let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let month = months[(c.month ?? 1) - 1]
        let year = c.year == Calendar.current.component(.year, from: Date()) ? "" : " \(c.year ?? 0)"
        let time = hasTime ? String(format: " %02d:%02d", c.hour ?? 0, c.minute ?? 0) : ""
        return "\(month) \(c.day ?? 0)\(year)\(time)"
    }

    /// "YYYY-MM-DD" → local-midnight Date (avoids UTC day shifts).
    static func localDay(_ ymd: String) -> Date? {
        let parts = ymd.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        return Calendar.current.date(from: components)
    }

    static func number(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }

    /// "09:00:00" → "09:00" (24h clock, owner preference).
    static func hhmm(_ time: String) -> String {
        String(time.prefix(5))
    }
}

// MARK: - Markdown

/// Render server-produced markdown (assistant answers, health reviews).
/// Falls back to plain text when parsing fails — never drops content.
struct MarkdownText: View {
    let markdown: String

    var body: some View {
        if let attributed = try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(attributed)
                .font(.system(size: 14))
                .foregroundStyle(T.ink)
                .textSelection(.enabled)
        } else {
            Text(markdown)
                .font(.system(size: 14))
                .foregroundStyle(T.ink)
                .textSelection(.enabled)
        }
    }
}
