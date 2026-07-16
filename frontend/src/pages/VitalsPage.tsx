/**
 * VitalsPage — vitals dashboard (route /vitals): hero chart, 4-card stats row
 * and recent-readings log, with a metric switcher (BP/Heart/Temp/SpO₂/Glucose).
 *
 * Implements the design handoff's `Web - Vitals.dc.html`. Deliberately omitted
 * from that design: the BP target band + "personal baseline" overlay and the
 * AI morning-vs-evening pattern card. Clinical thresholds are set with a
 * clinician, never fabricated by the UI (spec SR-3 — the page subtitle states
 * this to the user), and AI panels are never faked before their backend
 * exists (CLAUDE.md §2 "Design system").
 *
 * Architecture: leaf route in App.tsx's shell; read-only ("Log reading" links
 * to the Quick add page). One FHIR read on mount:
 * - Observation category=vital-signs date=ge{365d} _count=1000 _sort=date,
 *   split client-side by FHIR-MAPPING §2's verified LOINC codes: BP panel
 *   85354-9 (components 8480-6 systolic / 8462-4 diastolic), HR 8867-4,
 *   temperature 8310-5, SpO2 59408-5, glucose 2339-0.
 *
 * Data-class rule (three classes, CLAUDE.md §2): readings whose provenance is
 * a confirmed AI extraction render with the indigo ✦ chip ("AI-read ·
 * confirmed"); measured readings stay ink — AI output is never unlabeled, and
 * indigo never appears on non-AI content. Stats are plain arithmetic means
 * and ranges, shown without clinical judgment.
 */
import { Alert, Loader } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconPlus } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CardTitle, Chip, DsCard, PageHeader, StatusDot, SegmentedPills, TableRow } from '../components/ds';
import { BASE, IDENT, LOINC } from '../fhir';
import { T, mono } from '../tokens';

interface Point {
  date: string;
  value: number;
  /** full effectiveDateTime for display */
  at: string;
  source: string;
}

interface BpPoint {
  date: string;
  systolic?: number;
  diastolic?: number;
  /** full effectiveDateTime for display */
  at: string;
  source: string;
}

/** Single-value vitals: verified LOINC code → tab/title/unit/metric accent
 * (codes from FHIR-MAPPING §2's vitals row — never invented). BP is handled
 * separately because it is a component panel (85354-9), not one valueQuantity.
 * Colors are the design system's metric hues — data only, never chrome. */
const SIMPLE_VITALS: { code: string; title: string; tab: string; unit: string; color: string }[] = [
  { code: '8867-4', title: 'Heart rate', tab: 'Heart', unit: '/min', color: T.metric.heart },
  { code: '8310-5', title: 'Body temperature', tab: 'Temp', unit: '°C', color: T.metric.activity },
  { code: '59408-5', title: 'SpO2', tab: 'SpO₂', unit: '%', color: T.metric.respiratory },
  { code: '2339-0', title: 'Glucose', tab: 'Glucose', unit: 'mg/dL', color: T.metric.glucose },
];

type MetricKey = 'bp' | (typeof SIMPLE_VITALS)[number]['code'];

const METRIC_TABS: { value: MetricKey; label: string }[] = [
  { value: 'bp', label: 'BP' },
  ...SIMPLE_VITALS.map((v) => ({ value: v.code, label: v.tab })),
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO timestamp → 'Jul 14 07:05' in LOCAL time (year shown only when not current). */
function fmtWhen(iso: string): string {
  const hasTime = iso.length >= 16;
  // Date-only values get a local-midnight time so the calendar day is not shifted by TZ.
  const d = new Date(hasTime ? iso : `${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const month = MONTHS[d.getMonth()];
  const year = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
  const time = hasTime
    ? ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : '';
  return `${month} ${d.getDate()}${year}${time}`;
}

function fmtNum(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function mean(vals: number[]): number {
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function rangeStr(vals: number[]): string {
  return `${fmtNum(Math.min(...vals))}–${fmtNum(Math.max(...vals))}`;
}

/** Factual provenance for a reading — from identifiers/tags actually written by
 * the backend, never guessed: an ingestion identifier means the value passed
 * the review-queue gate after AI/OCR extraction (rendered with the ✦ AI chip);
 * the `imported` meta tag means a deterministic Phase-4 importer; `derivedFrom`
 * means the check-in Bot; anything else was logged by hand. */
function sourceOf(obs: Observation): string {
  if (obs.identifier?.some((i) => i.system === `${IDENT}/ingestion`)) {
    return 'AI-read · confirmed';
  }
  if (obs.meta?.tag?.some((t) => t.system === `${BASE}/tags` && t.code === 'imported')) {
    return 'imported';
  }
  if (obs.derivedFrom?.length) {
    return 'check-in';
  }
  return 'logged';
}

interface Stat {
  label: string;
  value: string;
  unit?: string;
  note: string;
}

/** BP stat cards: 90-day and 1-year systolic/diastolic averages plus 1-year
 * per-component ranges. Averages are computed per component over the readings
 * that carry it — plain arithmetic, no clinical judgment (SR-3). `since90` is
 * the YYYY-MM-DD lower bound for the short window. */
function buildBpStats(bp: BpPoint[], since90: string): Stat[] {
  const sys = (pts: BpPoint[]): number[] =>
    pts.map((p) => p.systolic).filter((v): v is number => v !== undefined);
  const dia = (pts: BpPoint[]): number[] =>
    pts.map((p) => p.diastolic).filter((v): v is number => v !== undefined);
  const pairAvg = (pts: BpPoint[]): string => {
    const s = sys(pts);
    const d = dia(pts);
    return s.length && d.length ? `${Math.round(mean(s))}/${Math.round(mean(d))}` : '—';
  };
  const recent = bp.filter((p) => p.date >= since90);
  const allSys = sys(bp);
  const allDia = dia(bp);
  return [
    {
      label: '90-day avg',
      value: pairAvg(recent),
      unit: 'mmHg',
      note: recent.length ? `over ${recent.length} readings` : 'no readings in window',
    },
    {
      label: '1-year avg',
      value: pairAvg(bp),
      unit: 'mmHg',
      note: bp.length ? `over ${bp.length} readings` : 'no readings yet',
    },
    {
      label: 'Systolic range',
      value: allSys.length ? rangeStr(allSys) : '—',
      unit: 'mmHg',
      note: '1-year low–high',
    },
    {
      label: 'Diastolic range',
      value: allDia.length ? rangeStr(allDia) : '—',
      unit: 'mmHg',
      note: '1-year low–high',
    },
  ];
}

/** Stat cards for a single-value vital: 90-day/1-year mean, 1-year low–high
 * range, reading count. Descriptive statistics only — no thresholds. */
function buildSimpleStats(points: Point[], unit: string, since90: string): Stat[] {
  const recent = points.filter((p) => p.date >= since90);
  const vals = points.map((p) => p.value);
  return [
    {
      label: '90-day avg',
      value: recent.length ? fmtNum(mean(recent.map((p) => p.value))) : '—',
      unit,
      note: recent.length ? `over ${recent.length} readings` : 'no readings in window',
    },
    {
      label: '1-year avg',
      value: vals.length ? fmtNum(mean(vals)) : '—',
      unit,
      note: vals.length ? `over ${vals.length} readings` : 'no readings yet',
    },
    {
      label: 'Range',
      value: vals.length ? rangeStr(vals) : '—',
      unit,
      note: '1-year low–high',
    },
    { label: 'Readings', value: String(points.length), note: 'last 365 days' },
  ];
}

/** One tile of the 4-card stats row (uppercase label, big mono value, note). */
function StatCard({ stat }: { stat: Stat }) {
  return (
    <DsCard padding="16px 18px" gap={6} style={{ borderRadius: 16 }}>
      <span style={{ ...mono(10, 400, T.quaternary), letterSpacing: '.1em', textTransform: 'uppercase' }}>
        {stat.label}
      </span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span style={{ ...mono(22, 500, T.ink), letterSpacing: '-.02em', whiteSpace: 'nowrap' }}>
          {stat.value}
        </span>
        {stat.unit ? <span style={mono(10.5, 400, T.tertiary)}>{stat.unit}</span> : null}
      </span>
      <span style={mono(10, 400, T.quaternary)}>{stat.note}</span>
    </DsCard>
  );
}

/** Renders a dot only on the newest point of a series (design: endpoint dot, none along the line). */
function endpointDot(color: string, lastIndex: number) {
  return function EndpointDot(props: {
    key?: React.Key | null;
    cx?: number;
    cy?: number;
    index?: number;
    value?: number | null;
  }) {
    const { key, cx, cy, index, value } = props;
    if (index !== lastIndex || cx === undefined || cy === undefined || value == null) {
      return <g key={key ?? undefined} />;
    }
    return <circle key={key ?? undefined} cx={cx} cy={cy} r={3.4} fill={color} />;
  };
}

const AXIS_TICK = { fontFamily: T.mono, fontSize: 10, fill: T.quaternary };

/** 'YYYY-MM-DD' → 'JUL' — month-only ticks suit the year-wide x axis. */
function monthTick(day: string): string {
  return MONTHS[Number(day.slice(5, 7)) - 1]?.toUpperCase() ?? day;
}

const TOOLTIP_STYLES = {
  contentStyle: {
    background: T.card,
    border: 'none',
    borderRadius: 12,
    boxShadow: T.shadowCard,
    fontFamily: T.mono,
    fontSize: 11,
  },
  labelStyle: { ...mono(10, 500, T.tertiary) },
  itemStyle: { fontFamily: T.mono, fontSize: 11 },
} as const;

interface ReadingRow {
  value: string;
  suffix: string;
  source: string;
  when: string;
}

/**
 * Vitals dashboard page. Loads a year of vital-sign Observations once on
 * mount; metric switching and stat building are pure client-side derivation —
 * no refetch per tab. Failure mode: a search error replaces the page with an
 * alert; individual metrics with no readings render their empty copy inline.
 */
export function VitalsPage() {
  const medplum = useMedplum();
  const [bp, setBp] = useState<BpPoint[]>();
  const [series, setSeries] = useState<Record<string, Point[]>>({});
  const [error, setError] = useState<string>();
  const [metric, setMetric] = useState<MetricKey>('bp');

  useEffect(() => {
    (async () => {
      try {
        const since = new Date();
        since.setDate(since.getDate() - 365);
        const observations = await medplum.searchResources('Observation', {
          category: 'vital-signs',
          date: `ge${since.toISOString().slice(0, 10)}`,
          _count: '1000',
          _sort: 'date',
        });
        // Split one bounded search by verified LOINC code: the BP panel
        // (85354-9) unpacks its systolic/diastolic components; every other
        // vitals code becomes its own single-value series keyed by code.
        // Unrecognized codes are simply not plotted — never guessed at.
        const bpPoints: BpPoint[] = [];
        const next: Record<string, Point[]> = {};
        for (const obs of observations) {
          const when = (obs.effectiveDateTime ?? '').slice(0, 10);
          if (!when) continue;
          const code = obs.code?.coding?.find((c) => c.system === LOINC)?.code;
          if (code === '85354-9') {
            const point: BpPoint = { date: when, at: obs.effectiveDateTime ?? '', source: sourceOf(obs) };
            for (const comp of obs.component ?? []) {
              const compCode = comp.code?.coding?.[0]?.code;
              if (compCode === '8480-6') point.systolic = comp.valueQuantity?.value;
              if (compCode === '8462-4') point.diastolic = comp.valueQuantity?.value;
            }
            if (point.systolic !== undefined || point.diastolic !== undefined) bpPoints.push(point);
          } else if (code && obs.valueQuantity?.value != null) {
            next[code] = [
              ...(next[code] ?? []),
              { date: when, value: obs.valueQuantity.value, at: obs.effectiveDateTime ?? '', source: sourceOf(obs) },
            ];
          }
        }
        setBp(bpPoints);
        setSeries(next);
      } catch (err) {
        setError(normalizeErrorString(err));
      }
    })();
  }, [medplum]);

  if (error) {
    return (
      <Alert color="red" title="Could not load vitals">
        {error}
      </Alert>
    );
  }
  if (!bp) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: 240 }}>
        <Loader color="hmdGreen" />
      </div>
    );
  }

  const since90Date = new Date();
  since90Date.setDate(since90Date.getDate() - 90);
  const since90 = since90Date.toISOString().slice(0, 10);

  const isBp = metric === 'bp';
  const vital = SIMPLE_VITALS.find((v) => v.code === metric);
  const points = vital ? (series[vital.code] ?? []) : [];

  const title = isBp ? 'Blood pressure' : (vital?.title ?? '');
  const unit = isBp ? 'mmHg' : (vital?.unit ?? '');
  const accent = isBp ? T.metric.bp : (vital?.color ?? T.ink);
  const count = isBp ? bp.length : points.length;
  const emptyCopy = isBp ? 'No blood pressure readings yet.' : 'No readings yet.';

  const latestBp = bp.length ? bp[bp.length - 1] : undefined;
  const latestSimple = points.length ? points[points.length - 1] : undefined;
  const latestValue = isBp
    ? latestBp && `${latestBp.systolic ?? '—'}/${latestBp.diastolic ?? '—'}`
    : latestSimple && fmtNum(latestSimple.value);
  const latestAt = isBp ? latestBp?.at : latestSimple?.at;

  const stats = isBp ? buildBpStats(bp, since90) : buildSimpleStats(points, unit, since90);

  const rows: ReadingRow[] = (
    isBp
      ? bp.slice(-8).map((p) => ({
          value: `${p.systolic ?? '—'}/${p.diastolic ?? '—'}`,
          suffix: 'mmHg',
          source: p.source,
          when: fmtWhen(p.at),
        }))
      : points.slice(-8).map((p) => ({
          value: fmtNum(p.value),
          suffix: unit,
          source: p.source,
          when: fmtWhen(p.at),
        }))
  ).reverse();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Vitals"
        subtitle="Trends over the last year — log readings under Quick add. Values are shown without clinical judgment; thresholds worth flagging are something to set with your clinician."
        right={
          <>
            <SegmentedPills options={METRIC_TABS} value={metric} onChange={setMetric} />
            <Link
              to="/log"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                background: T.green,
                color: '#fff',
                borderRadius: 20,
                padding: '9px 18px',
                fontSize: 13,
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              <IconPlus size={14} stroke={2.2} />
              Log reading
            </Link>
          </>
        }
      />

      {/* Hero chart card */}
      <DsCard padding="22px 26px" gap={14}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <StatusDot color={accent} size={8} />
          <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-.015em' }}>{title}</span>
          {latestValue !== undefined ? (
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
              <span style={{ ...mono(24, 500, T.ink), letterSpacing: '-.02em', whiteSpace: 'nowrap' }}>
                {latestValue}
              </span>
              <span style={mono(10.5, 400, T.tertiary)}>
                {unit} · {latestAt ? fmtWhen(latestAt) : ''}
              </span>
            </span>
          ) : null}
        </div>

        {count === 0 ? (
          <div style={{ height: 190, display: 'grid', placeItems: 'center' }}>
            <span style={mono(11, 400, T.quaternary)}>{emptyCopy}</span>
          </div>
        ) : isBp ? (
          <ResponsiveContainer width="100%" height={190}>
            <LineChart data={bp} margin={{ top: 10, right: 10, bottom: 0, left: 10 }}>
              <XAxis
                dataKey="date"
                axisLine={false}
                tickLine={false}
                minTickGap={80}
                tick={AXIS_TICK}
                tickFormatter={monthTick}
              />
              {/* 40–200 mmHg is a stable display window so the chart doesn't
                  rescale between visits — NOT a clinical band (SR-3). */}
              <YAxis hide domain={[40, 200]} />
              <ChartTooltip {...TOOLTIP_STYLES} />
              <Line
                type="monotone"
                dataKey="systolic"
                stroke={T.metric.bp}
                strokeWidth={2.2}
                strokeLinecap="round"
                dot={endpointDot(T.metric.bp, bp.length - 1)}
                activeDot={{ r: 3.4, fill: T.metric.bp, stroke: 'none' }}
              />
              <Line
                type="monotone"
                dataKey="diastolic"
                stroke={T.metric.bpDia}
                strokeWidth={2}
                strokeLinecap="round"
                dot={endpointDot(T.metric.bpDia, bp.length - 1)}
                activeDot={{ r: 3.4, fill: T.metric.bpDia, stroke: 'none' }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height={190}>
            <LineChart data={points} margin={{ top: 10, right: 10, bottom: 0, left: 10 }}>
              <XAxis
                dataKey="date"
                axisLine={false}
                tickLine={false}
                minTickGap={80}
                tick={AXIS_TICK}
                tickFormatter={monthTick}
              />
              <YAxis hide domain={['auto', 'auto']} />
              <ChartTooltip {...TOOLTIP_STYLES} />
              <Line
                type="monotone"
                dataKey="value"
                name={title.toLowerCase()}
                stroke={accent}
                strokeWidth={2.2}
                strokeLinecap="round"
                dot={endpointDot(accent, points.length - 1)}
                activeDot={{ r: 3.4, fill: accent, stroke: 'none' }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}

        <div style={{ display: 'flex', gap: 16, ...mono(10, 400, T.tertiary) }}>
          {isBp ? (
            <>
              <span>
                <span style={{ color: T.metric.bp }}>—</span> systolic
              </span>
              <span>
                <span style={{ color: T.metric.bpDia }}>—</span> diastolic
              </span>
            </>
          ) : (
            <span>
              <span style={{ color: accent }}>—</span> {title.toLowerCase()}
            </span>
          )}
          <span style={{ marginLeft: 'auto' }}>
            {count} reading{count === 1 ? '' : 's'} · 1Y
          </span>
        </div>
      </DsCard>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        {stats.map((stat) => (
          <StatCard key={stat.label} stat={stat} />
        ))}
      </div>

      {/* Recent readings */}
      <DsCard flush>
        <div style={{ display: 'flex', alignItems: 'center', padding: '16px 22px 10px' }}>
          <CardTitle size={14.5}>Recent readings</CardTitle>
          <span style={{ marginLeft: 'auto', ...mono(10.5, 400, T.quaternary) }}>
            {count} in the last year
          </span>
        </div>
        {rows.length === 0 ? (
          <TableRow padding="14px 22px">
            <span style={mono(10.5, 400, T.quaternary)}>{emptyCopy}</span>
          </TableRow>
        ) : (
          rows.map((r, i) => (
            <TableRow key={`${r.when}-${i}`} columns="auto 1fr auto auto" padding="10px 22px">
              <StatusDot color={accent} size={7} />
              <span style={{ ...mono(14, 500, T.ink), letterSpacing: '-.01em', whiteSpace: 'nowrap' }}>
                {r.value} <span style={mono(9.5, 400, T.quaternary)}>{r.suffix}</span>
              </span>
              {r.source === 'AI-read · confirmed' ? (
                <Chip ai>✦ {r.source}</Chip>
              ) : (
                <span style={mono(10, 400, T.quaternary)}>{r.source}</span>
              )}
              <span style={mono(10, 400, T.quaternary)}>{r.when}</span>
            </TableRow>
          ))
        )}
      </DsCard>
    </div>
  );
}
