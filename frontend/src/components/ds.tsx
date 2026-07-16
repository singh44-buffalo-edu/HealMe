/**
 * HealMeDaily design-system primitives.
 * Source of truth: design_handoff_healmedaily / "HealMeDaily Design System v2".
 * Pixel values are intentional — do not round to Mantine spacing tokens.
 */
import type { CSSProperties, ReactNode } from 'react';
import { T, mono } from '../tokens';

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function DsCard({
  children,
  ai = false,
  dark = false,
  padding = 20,
  gap = 12,
  flush = false,
  style,
}: {
  children: ReactNode;
  /** AI-flavored card: indigo-tinted shadow */
  ai?: boolean;
  /** Dark hero card (#1d1d1f, light text, no shadow tint change) */
  dark?: boolean;
  padding?: number | string;
  gap?: number;
  /** flush: no padding — for table cards with full-bleed rows (use overflow hidden) */
  flush?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: dark ? T.ink : T.card,
        color: dark ? '#f5f5f4' : undefined,
        borderRadius: 18,
        padding: flush ? 0 : padding,
        display: 'flex',
        flexDirection: 'column',
        gap,
        boxShadow: ai ? T.shadowAi : T.shadowCard,
        overflow: flush ? 'hidden' : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Typography helpers
// ---------------------------------------------------------------------------

/** Section eyebrow: mono 10.5px uppercase, letter-spacing .12em */
export function Eyebrow({ children, color = T.tertiary }: { children: ReactNode; color?: string }) {
  return (
    <span
      style={{
        ...mono(10.5, 500, color),
        textTransform: 'uppercase',
        letterSpacing: '.12em',
      }}
    >
      {children}
    </span>
  );
}

/** Card header title (14–15px 600) */
export function CardTitle({ children, size = 15 }: { children: ReactNode; size?: number }) {
  return (
    <span style={{ fontSize: size, fontWeight: 600, letterSpacing: '-.01em' }}>{children}</span>
  );
}

// ---------------------------------------------------------------------------
// Page header
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.02em' }}>{title}</span>
        {subtitle ? <span style={mono(12)}>{subtitle}</span> : null}
      </div>
      {right ? (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {right}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status & data-class primitives
// ---------------------------------------------------------------------------

export function StatusDot({
  color,
  size = 7,
  pulse = false,
}: {
  color: string;
  size?: number;
  pulse?: boolean;
}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        display: 'inline-block',
        animation: pulse ? 'hmdPulse 2s infinite' : undefined,
      }}
    />
  );
}

/** Mandatory AI label — every AI-derived value/card carries this. */
export function AIPill({ label = 'AI' }: { label?: string }) {
  return (
    <span
      style={{
        ...mono(9, 500, T.ai),
        letterSpacing: '.08em',
        background: T.aiBg,
        borderRadius: 20,
        padding: '3px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      ✦ {label}
    </span>
  );
}

/** Neutral provenance chip; ai variant renders indigo. */
export function Chip({
  children,
  ai = false,
  style,
}: {
  children: ReactNode;
  ai?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        ...mono(10.5, 400, ai ? T.ai : T.secondary),
        background: ai ? T.aiBg : T.band,
        borderRadius: 20,
        padding: '4px 10px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** VaultChip — the privacy promise, on every screen. */
export function VaultChip({ suffix, fullWidth = false }: { suffix?: string; fullWidth?: boolean }) {
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        background: T.band,
        borderRadius: 20,
        padding: '6px 12px',
        alignSelf: fullWidth ? 'stretch' : 'flex-start',
      }}
    >
      <StatusDot color={T.inRange} size={6} />
      <span style={mono(10.5, 500, T.ink)}>On this device</span>
      {suffix ? <span style={mono(11, 400, T.quaternary)}>· {suffix}</span> : null}
    </span>
  );
}

/** DataBoundaryNotice row — local (green, stays home) vs cloud (amber, leaves device). */
export function BoundaryRow({
  local,
  name,
  detail,
}: {
  local: boolean;
  name: string;
  detail?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        border: `1px solid ${T.chip}`,
        borderRadius: 12,
        padding: '10px 12px',
      }}
    >
      <StatusDot color={local ? T.inRange : T.watch} size={7} />
      <span style={{ fontSize: 12.5, fontWeight: 500 }}>{name}</span>
      {detail ? <span style={mono(10, 400, T.quaternary)}>{detail}</span> : null}
      <span style={{ marginLeft: 'auto', ...mono(10, 400, local ? T.quaternary : T.watch) }}>
        {local ? 'stays home' : 'leaves device'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function SegmentedPills<V extends string>({
  options,
  value,
  onChange,
  size = 'range',
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  /** 'range' = mono 11px chart-range size; 'tab' = sans 12.5px tab size */
  size?: 'range' | 'tab';
}) {
  const isTab = size === 'tab';
  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        background: T.chip,
        borderRadius: isTab ? 22 : 20,
        padding: isTab ? 3 : 2,
        alignSelf: 'flex-start',
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              border: 'none',
              cursor: 'pointer',
              ...(isTab
                ? { fontFamily: 'inherit', fontSize: 12.5, fontWeight: 500 }
                : mono(11, 500, active ? T.ink : T.tertiary)),
              color: active ? T.ink : T.tertiary,
              padding: isTab ? '7px 16px' : '4px 12px',
              borderRadius: isTab ? 18 : 16,
              background: active ? '#ffffff' : 'transparent',
              boxShadow: active ? T.shadowSegment : undefined,
              whiteSpace: 'nowrap',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Stateful filter chips (Timeline / History Log recipe): active = white on ink,
 * inactive = secondary on white with a whisper shadow. `ai` chips keep indigo identity.
 */
export function FilterChips<V extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: V; label: string; count?: number | string; ai?: boolean }[];
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const active = o.value === value;
        const fg = o.ai ? (active ? '#ffffff' : T.ai) : active ? '#ffffff' : T.secondary;
        const bg = o.ai ? (active ? T.ai : T.aiBg) : active ? T.ink : '#ffffff';
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              borderRadius: 20,
              padding: '7px 15px',
              fontSize: 12.5,
              fontWeight: 500,
              fontFamily: 'inherit',
              color: fg,
              background: bg,
              boxShadow: active || o.ai ? 'none' : '0 1px 2px rgba(0,0,0,.05)',
              whiteSpace: 'nowrap',
            }}
          >
            {o.label}
            {o.count !== undefined ? (
              <span style={mono(10.5, 500, active ? '#d1d1d6' : T.quaternary)}>{o.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export type PillButtonVariant =
  | 'primary' // green
  | 'ink'
  | 'secondary'
  | 'ghost'
  | 'destructive'
  | 'destructive-tint';

const BTN: Record<PillButtonVariant, CSSProperties> = {
  primary: { background: T.green, color: '#fff', fontWeight: 600, padding: '9px 18px' },
  ink: { background: T.ink, color: '#fff', fontWeight: 500, padding: '6px 14px' },
  secondary: { background: T.band, color: T.secondary, fontWeight: 500, padding: '6px 14px' },
  ghost: { background: 'transparent', color: T.tertiary, fontWeight: 500, padding: '4px 12px' },
  destructive: { background: T.outOfRange, color: '#fff', fontWeight: 600, padding: '8px 16px' },
  'destructive-tint': {
    background: T.destructiveTint,
    color: T.outOfRange,
    fontWeight: 500,
    padding: '7px 16px',
  },
};

export function PillButton({
  variant = 'secondary',
  children,
  onClick,
  disabled = false,
  disabledReason,
  type = 'button',
  size = 13,
  style,
}: {
  variant?: PillButtonVariant;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** gated buttons may carry the blocking reason as their label */
  disabledReason?: string;
  type?: 'button' | 'submit';
  size?: number;
  style?: CSSProperties;
}) {
  const base = BTN[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit',
        fontSize: size,
        borderRadius: 20,
        whiteSpace: 'nowrap',
        ...base,
        ...(disabled ? { background: T.disabled, color: '#fff' } : null),
        ...style,
      }}
    >
      {disabled && disabledReason ? disabledReason : children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

/** Confidence/progress bar: 3px track, animated width. Indigo for AI confidence. */
export function ConfidenceBar({
  value,
  color = T.ai,
  label,
  valueLabel,
}: {
  /** 0..1 */
  value: number;
  color?: string;
  label?: string;
  valueLabel?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {label || valueLabel ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', ...mono(10) }}>
          <span>{label}</span>
          <span>{valueLabel}</span>
        </div>
      ) : null}
      <div style={{ height: 3, background: T.chip, borderRadius: 2 }}>
        <div
          style={{
            height: '100%',
            borderRadius: 2,
            width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`,
            background: color,
            transition: 'width .4s ease',
          }}
        />
      </div>
    </div>
  );
}

/** 30-day adherence heatstrip: 6×14px bars. */
export function Heatstrip({
  days,
  header,
  headerRight,
}: {
  /** hex per day: T.inRange taken · T.outOfRange missed · T.hairline neutral */
  days: string[];
  header?: string;
  headerRight?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {header || headerRight ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', ...mono(9.5, 400, T.quaternary) }}>
          <span>{header}</span>
          <span>{headerRight}</span>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 2 }}>
        {days.map((c, i) => (
          <span key={i} style={{ width: 6, height: 14, borderRadius: 2, background: c }} />
        ))}
      </div>
    </div>
  );
}

/** Sparkline with whisper-gray reference band, series line, end dot. */
export function Sparkline({
  values,
  accent,
  width = 200,
  height = 36,
  band = true,
  bandFill = T.band,
}: {
  values: number[];
  accent: string;
  width?: number;
  height?: number;
  band?: boolean;
  bandFill?: string;
}) {
  if (values.length < 2) {
    return <div style={{ height }} />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 5;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const last = pts[pts.length - 1];
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', height, display: 'block' }}
      preserveAspectRatio="none"
    >
      {band ? (
        <rect x={0} y={height * 0.28} width={width} height={height * 0.44} rx={3} fill={bandFill} />
      ) : null}
      <polyline
        points={pts.map(([x, y]) => `${x},${y}`).join(' ')}
        fill="none"
        stroke={accent}
        strokeWidth={1.7}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last[0]} cy={last[1]} r={2.8} fill={accent} />
    </svg>
  );
}

/** Page-level status strip. */
export function StatusStrip({
  dotColor = T.inRange,
  headline,
  watch,
  right,
}: {
  dotColor?: string;
  headline: ReactNode;
  watch?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <DsCard padding="16px 22px" gap={0} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 } as CSSProperties}>
      <StatusDot color={dotColor} size={10} />
      <span style={{ fontSize: 14, fontWeight: 500, letterSpacing: '-.01em' }}>{headline}</span>
      {watch ? <span style={{ ...mono(11.5, 400, T.watch) }}>{watch}</span> : null}
      {right ? <span style={{ marginLeft: 'auto' }}>{right}</span> : null}
    </DsCard>
  );
}

/** Full-bleed row inside a flush DsCard table. */
export function TableRow({
  children,
  columns,
  first = false,
  padding = '12px 22px',
}: {
  children: ReactNode;
  columns?: string;
  first?: boolean;
  padding?: string;
}) {
  return (
    <div
      style={{
        display: columns ? 'grid' : 'flex',
        gridTemplateColumns: columns,
        alignItems: 'center',
        gap: 14,
        padding,
        borderTop: first ? 'none' : `1px solid ${T.band}`,
      }}
    >
      {children}
    </div>
  );
}

/** Date badge for upcoming rows: month over day on band bg. */
export function DateBadge({ month, day }: { month: string; day: string | number }) {
  return (
    <span
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        background: T.band,
        borderRadius: 10,
        padding: '6px 10px',
      }}
    >
      <span style={mono(10, 500, T.tertiary)}>{month}</span>
      <span style={mono(15, 500, T.ink)}>{day}</span>
    </span>
  );
}
