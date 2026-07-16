/**
 * HealMeDaily design tokens for JS/SVG use — mirrors theme.css custom
 * properties; the two files must change in lockstep. Source of truth: the
 * design handoff at `personal-health-record-system 2/project/
 * design_handoff_healmedaily/` (README token tables + "HealMeDaily Design
 * System v2.dc.html") — never invent a new hex, trace it to the handoff.
 *
 * Three-data-classes rule (non-negotiable, CLAUDE.md §2): measured data =
 * ink · live device data = green + pulsing dot · AI-derived = indigo `T.ai`
 * + ✦ AI pill + confidence. Never render AI output unlabeled, and never use
 * indigo on non-AI content — in this app the hue IS the label.
 */
import type { CSSProperties } from 'react';

export const T = {
  // surfaces — cards are borderless white on soft shadow over the canvas
  canvas: '#efefed',
  card: '#ffffff',
  cardFooter: '#fafaf9',
  band: '#f4f4f2',
  chip: '#f0f0ee',
  hairline: '#e8e8e5',
  // text ramp — ink is also the "measured data" class color
  ink: '#1d1d1f',
  secondary: '#6e6e73',
  tertiary: '#86868b',
  quaternary: '#aeaeb2',
  disabled: '#c9c9c5',
  // brand + status — status color goes on values/dots, never floods a card;
  // watch (amber) also marks cloud data boundaries (BoundaryRow)
  green: '#0f8a63',
  greenHover: '#0a6b4c',
  inRange: '#1e9e6a',
  watch: '#c7811b',
  outOfRange: '#d64545',
  // AI class — indigo marks AI-derived content ONLY (see file header)
  ai: '#5e5ce6',
  aiDeep: '#4b49c8',
  aiBg: '#efeffc',
  aiBorder: '#deddf9',
  // live-device deep-green tile (reserved for real device feeds, e.g. CGM)
  liveBg: '#062e22',
  liveText: '#f2fbf7',
  liveAccent: '#4fd6a6',
  liveMuted: '#8fc9b4',
  liveFaint: '#5e9781',
  destructiveTint: '#fbefef',
  greenTint: '#e7f4ef',
  // adherence heat trio (calendar cells) — tinted, softer than status colors
  heatTaken: '#ddf2e8',
  heatMissed: '#f8dede',
  heatLate: '#fbf3e4',
  // metric accents color DATA ONLY (lines, dots, rings) — never chrome; one
  // canonical hue per metric app-wide
  metric: {
    heart: '#ff375f',
    glucose: '#0f8a63',
    sleep: '#00b7c3',
    activity: '#ff9500',
    bp: '#0a84ff',
    bpDia: '#7cbbff',
    weight: '#bf5af2',
    respiratory: '#64d2ff',
    labs: '#e8b10e',
    // canonical app-wide assignments for tracker metrics without a design token —
    // every page must use the same hue per metric
    mood: '#64d2ff',
    energy: '#ff9500',
  },
  shadowCard: '0 1px 2px rgba(0,0,0,.04), 0 8px 28px rgba(0,0,0,.05)',
  shadowCardHover: '0 2px 4px rgba(0,0,0,.05), 0 12px 36px rgba(0,0,0,.08)',
  shadowAi: '0 1px 2px rgba(94,92,230,.08), 0 8px 28px rgba(94,92,230,.10)',
  shadowSegment: '0 1px 3px rgba(0,0,0,.08)',
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

/** Inline style for the mono "data voice": numbers, units, timestamps and
 * codes are ALWAYS IBM Plex Mono (design rule) — prose never is. Weight is
 * capped at 500 because only 400/500 fonts are bundled (see main.tsx). */
export const mono = (
  size: number,
  weight: 400 | 500 = 400,
  color: string = T.tertiary
): CSSProperties => ({
  fontFamily: T.mono,
  fontSize: size,
  fontWeight: weight,
  color,
});

