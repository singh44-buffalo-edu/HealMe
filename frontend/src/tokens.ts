/**
 * HealMeDaily design tokens for JS/SVG use — mirrors theme.css custom properties.
 * Source: design_handoff_healmedaily / "HealMeDaily Design System v2".
 */
import type { CSSProperties } from 'react';

export const T = {
  canvas: '#efefed',
  card: '#ffffff',
  cardFooter: '#fafaf9',
  band: '#f4f4f2',
  chip: '#f0f0ee',
  hairline: '#e8e8e5',
  ink: '#1d1d1f',
  secondary: '#6e6e73',
  tertiary: '#86868b',
  quaternary: '#aeaeb2',
  disabled: '#c9c9c5',
  green: '#0f8a63',
  greenHover: '#0a6b4c',
  inRange: '#1e9e6a',
  watch: '#c7811b',
  outOfRange: '#d64545',
  ai: '#5e5ce6',
  aiDeep: '#4b49c8',
  aiBg: '#efeffc',
  aiBorder: '#deddf9',
  liveBg: '#062e22',
  liveText: '#f2fbf7',
  liveAccent: '#4fd6a6',
  liveMuted: '#8fc9b4',
  liveFaint: '#5e9781',
  destructiveTint: '#fbefef',
  greenTint: '#e7f4ef',
  heatTaken: '#ddf2e8',
  heatMissed: '#f8dede',
  heatLate: '#fbf3e4',
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

