import SwiftUI
import UIKit

/// HealMeDaily design tokens for SwiftUI — mirrors `frontend/src/tokens.ts`
/// (which mirrors theme.css); never invent a new hex, trace it to the design
/// handoff. The app forces light appearance: the design system is light-first
/// and these are absolute ink-on-paper values, not semantic colors.
///
/// Three-data-classes rule (non-negotiable, CLAUDE.md §2): measured data =
/// ink · live device data = green + pulsing dot · AI-derived = indigo `T.ai`
/// + ✦ AI pill + confidence. Never render AI output unlabeled, and never use
/// indigo on non-AI content — in this app the hue IS the label.
enum T {
    // surfaces — cards are borderless white on soft shadow over the canvas
    static let canvas = Color(hex: 0xEFEFED)
    static let card = Color(hex: 0xFFFFFF)
    static let cardFooter = Color(hex: 0xFAFAF9)
    static let band = Color(hex: 0xF4F4F2)
    static let chip = Color(hex: 0xF0F0EE)
    static let hairline = Color(hex: 0xE8E8E5)
    // text ramp — ink is also the "measured data" class color
    static let ink = Color(hex: 0x1D1D1F)
    static let secondary = Color(hex: 0x6E6E73)
    static let tertiary = Color(hex: 0x86868B)
    static let quaternary = Color(hex: 0xAEAEB2)
    static let disabled = Color(hex: 0xC9C9C5)
    // brand + status — status color goes on values/dots, never floods a card;
    // watch (amber) also marks cloud data boundaries (BoundaryRow)
    static let green = Color(hex: 0x0F8A63)
    static let greenHover = Color(hex: 0x0A6B4C)
    static let inRange = Color(hex: 0x1E9E6A)
    static let watch = Color(hex: 0xC7811B)
    static let outOfRange = Color(hex: 0xD64545)
    // AI class — indigo marks AI-derived content ONLY (see header)
    static let ai = Color(hex: 0x5E5CE6)
    static let aiDeep = Color(hex: 0x4B49C8)
    static let aiBg = Color(hex: 0xEFEFFC)
    static let aiBorder = Color(hex: 0xDEDDF9)
    static let destructiveTint = Color(hex: 0xFBEFEF)
    static let greenTint = Color(hex: 0xE7F4EF)
    // adherence heat trio (calendar cells) — tinted, softer than status colors
    static let heatTaken = Color(hex: 0xDDF2E8)
    static let heatMissed = Color(hex: 0xF8DEDE)
    static let heatLate = Color(hex: 0xFBF3E4)

    /// Metric accents color DATA ONLY (lines, dots, rings) — never chrome;
    /// one canonical hue per metric app-wide.
    enum Metric {
        static let heart = Color(hex: 0xFF375F)
        static let glucose = Color(hex: 0x0F8A63)
        static let sleep = Color(hex: 0x00B7C3)
        static let activity = Color(hex: 0xFF9500)
        static let bp = Color(hex: 0x0A84FF)
        static let bpDia = Color(hex: 0x7CBBFF)
        static let weight = Color(hex: 0xBF5AF2)
        static let respiratory = Color(hex: 0x64D2FF)
        static let labs = Color(hex: 0xE8B10E)
        static let mood = Color(hex: 0x64D2FF)
        static let energy = Color(hex: 0xFF9500)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

extension Font {
    /// The mono "data voice": numbers, units, timestamps and codes are ALWAYS
    /// monospaced (design rule) — prose never is. The web bundles IBM Plex
    /// Mono; on iOS the system monospaced design (SF Mono) plays that role.
    /// Dynamic Type-aware via `scaled` (see there for the semantics).
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular, maxScale: CGFloat? = nil) -> Font {
        .system(size: scaled(size, maxScale: maxScale), weight: weight, design: .monospaced)
    }

    /// The proportional "UI voice" — the app-target counterpart of the web's
    /// fixed px sizes. Every `.font(.system(size:))` call site routes through
    /// here so the design-handoff size scales with the user's Dynamic Type
    /// setting (med names, SIG text, lab values must all grow).
    static func ui(_ size: CGFloat, weight: Font.Weight = .regular, maxScale: CGFloat? = nil) -> Font {
        .system(size: scaled(size, maxScale: maxScale), weight: weight)
    }

    /// Dynamic Type scaling for a design-handoff base size: at the default
    /// (Large) setting this returns `size` unchanged, at other settings it
    /// follows the curve of the nearest built-in text style (small auxiliary
    /// text deliberately grows less than body text, exactly like the system).
    ///
    /// `maxScale` is the guard rail for genuinely tight layouts (segmented
    /// pills, chart axis ticks, legends): growth is clamped to
    /// `size * maxScale`. NOTE: `.dynamicTypeSize(...)` view modifiers do NOT
    /// cap these fonts — the size is resolved here, not from the SwiftUI
    /// environment — so use `maxScale` instead. Trade-off of that design:
    /// a mid-session text-size change is picked up on the next body
    /// evaluation (navigation, tab switch, data refresh, relaunch), not
    /// live-instantly; acceptable first pass, and Settings-app changes
    /// background us anyway.
    static func scaled(_ size: CGFloat, maxScale: CGFloat? = nil) -> CGFloat {
        let value = UIFontMetrics(forTextStyle: textStyle(for: size)).scaledValue(for: size)
        guard let maxScale else { return value }
        return min(value, size * maxScale)
    }

    /// Base size → the built-in text style whose Dynamic Type CURVE it
    /// borrows (nearest by default-setting point size; the base size itself
    /// is always preserved at the default setting). Keep the mapping here —
    /// nowhere else.
    private static func textStyle(for size: CGFloat) -> UIFont.TextStyle {
        switch size {
        case ..<11.5: return .caption2 // 9–11 · eyebrows, chips, legends
        case ..<12.5: return .caption1 // 12 · secondary mono values
        case ..<14: return .footnote // 12.5–13.5 · row text, buttons
        case ..<15.5: return .subheadline // 14–15 · body copy, med names
        case ..<17: return .callout // 16 · card titles
        case ..<18.5: return .body // 17 · screen-level headings
        case ..<22: return .title3 // 20 · icons, section numbers
        case ..<30: return .title2 // 24–26 · page titles
        default: return .largeTitle // 44 · adherence hero %
        }
    }
}
