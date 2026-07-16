import { Loader } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconPlus } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { DsCard, PageHeader, PillButton, SegmentedPills, StatusDot } from '../components/ds';
import { T, mono } from '../tokens';

interface Analyte {
  name: string;
  unit: string;
  low?: number;
  high?: number;
  points: { date: string; value: number }[];
  latest: { date: string; value: number };
  outOfRange: boolean;
}

type ViewMode = 'panel' | 'date' | 'flagged';
type HeroRange = '1Y' | '3Y' | 'ALL';

const VIEW_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: 'panel', label: 'By panel' },
  { value: 'date', label: 'By date' },
  { value: 'flagged', label: 'Flagged' },
];

const RANGE_OPTIONS: { value: HeroRange; label: string }[] = [
  { value: '1Y', label: '1Y' },
  { value: '3Y', label: '3Y' },
  { value: 'ALL', label: 'ALL' },
];

const RANGE_DAYS: Record<HeroRange, number | undefined> = { '1Y': 365, '3Y': 1095, ALL: undefined };

/** Presentation-only grouping of analyte display names into familiar panel cards. */
const PANEL_DEFS: { name: string; match: RegExp }[] = [
  { name: 'Metabolic', match: /a1c|glucose|insulin|homa/i },
  { name: 'Lipids', match: /cholesterol|\bldl\b|\bhdl\b|triglycer|lipoprotein/i },
  {
    name: 'Kidney & electrolytes',
    match: /creatinin|egfr|glomerular|sodium|potassium|chloride|bicarbonate|\bbun\b|urea|uric/i,
  },
  {
    name: 'Liver',
    match: /\balt\b|\bast\b|\balp\b|alanine|aspartate|alkaline phos|bilirubin|albumin|\bggt\b|glutamyl|protein/i,
  },
  {
    name: 'Blood counts',
    match: /hemoglobin|hematocrit|platelet|leukocyte|erythrocyte|\bwbc\b|\brbc\b|\bmcv\b|\bmch\b|neutrophil|lymphocyte/i,
  },
  {
    name: 'Thyroid & vitamins',
    match: /\btsh\b|thyrox|thyroid|\bt3\b|\bt4\b|vitamin|25-oh|b12|cobalamin|folate|ferritin|\biron\b/i,
  },
];
const OTHER_PANEL = 'Other results';

interface LabPanel {
  name: string;
  analytes: Analyte[];
}

export function LabsPage() {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [analytes, setAnalytes] = useState<Analyte[]>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<ViewMode>('panel');
  const [heroRange, setHeroRange] = useState<HeroRange>('3Y');
  const [heroName, setHeroName] = useState<string>();

  useEffect(() => {
    (async () => {
      try {
        const observations = await medplum.searchResources('Observation', {
          category: 'laboratory',
          _count: '1000',
          _sort: 'date',
        });
        setAnalytes(groupAnalytes(observations));
      } catch (err) {
        setError(normalizeErrorString(err));
      }
    })();
  }, [medplum]);

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <PageHeader title="Labs" />
        <DsCard padding="22px 26px" gap={6}>
          <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: '-.01em' }}>
            Could not load labs
          </span>
          <span style={mono(12, 400, T.tertiary)}>{error}</span>
        </DsCard>
      </div>
    );
  }
  if (!analytes) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
        <Loader size="sm" />
      </div>
    );
  }

  const totalResults = analytes.reduce((n, a) => n + a.points.length, 0);
  const allDates = analytes.flatMap((a) => a.points.map((p) => p.date));
  const subtitle =
    analytes.length > 0
      ? `${analytes.length} analytes · ${totalResults} results · ${spanText(
          allDates.reduce((m, d) => (d < m ? d : m), allDates[0]),
          allDates.reduce((m, d) => (d > m ? d : m), allDates[0])
        )}`
      : 'no results yet';

  const defaultHero = analytes.reduce<Analyte | undefined>(
    (best, a) => (!best || a.points.length > best.points.length ? a : best),
    undefined
  );
  const hero = analytes.find((a) => a.name === heroName) ?? defaultHero;

  const panels = buildPanels(analytes);
  const flaggedPanels = panels
    .map((p) => ({ ...p, analytes: p.analytes.filter((a) => a.outOfRange) }))
    .filter((p) => p.analytes.length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Labs"
        subtitle={subtitle}
        right={
          <>
            <SegmentedPills options={VIEW_OPTIONS} value={view} onChange={setView} />
            <PillButton
              variant="primary"
              onClick={() => navigate('/ingest')}
              style={{ display: 'flex', alignItems: 'center', gap: 7 }}
            >
              <IconPlus size={14} stroke={2} /> Add results
            </PillButton>
          </>
        }
      />

      {analytes.length === 0 ? (
        <DsCard padding="22px 26px">
          <span style={mono(12, 400, T.quaternary)}>
            No lab results yet — approve extracted lab values from an uploaded report. Upload lab
            reports under Documents to add more history.
          </span>
        </DsCard>
      ) : (
        <>
          <span style={mono(11, 400, T.tertiary)}>
            Per-analyte trends against the reference range stated on each report. Upload lab
            reports under Documents to add more history.
          </span>

          {hero ? (
            <HeroTrendCard analyte={hero} range={heroRange} onRange={setHeroRange} />
          ) : null}

          {view === 'panel' ? (
            <PanelGrid panels={panels} onSelect={setHeroName} onHistory={() => setView('date')} />
          ) : null}

          {view === 'flagged' ? (
            flaggedPanels.length > 0 ? (
              <PanelGrid
                panels={flaggedPanels}
                onSelect={setHeroName}
                onHistory={() => setView('date')}
              />
            ) : (
              <DsCard padding="22px 26px">
                <span style={mono(12, 400, T.quaternary)}>
                  Nothing flagged — every latest result is inside its stated reference range.
                </span>
              </DsCard>
            )
          ) : null}

          {view === 'date' ? <ByDateCard analytes={analytes} onSelect={setHeroName} /> : null}
        </>
      )}
    </div>
  );
}

function groupAnalytes(observations: Observation[]): Analyte[] {
  const groups = new Map<string, Observation[]>();
  for (const obs of observations) {
    if (obs.valueQuantity?.value == null) continue;
    const name = obs.code?.text ?? obs.code?.coding?.[0]?.display ?? obs.code?.coding?.[0]?.code;
    if (!name) continue;
    groups.set(name, [...(groups.get(name) ?? []), obs]);
  }
  const analytes: Analyte[] = [];
  for (const [name, group] of groups) {
    const points = group
      .map((o) => ({
        date: (o.effectiveDateTime ?? '').slice(0, 10),
        value: o.valueQuantity?.value as number,
      }))
      .filter((p) => p.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (points.length === 0) continue;
    const withRange = group.find((o) => o.referenceRange?.[0]);
    const range = withRange?.referenceRange?.[0];
    const low = range?.low?.value;
    const high = range?.high?.value;
    const latest = points[points.length - 1];
    analytes.push({
      name,
      unit: group[0].valueQuantity?.unit ?? '',
      low,
      high,
      points,
      latest,
      outOfRange:
        (low != null && latest.value < low) || (high != null && latest.value > high),
    });
  }
  return analytes.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Hero trend card
// ---------------------------------------------------------------------------

function HeroTrendCard({
  analyte,
  range,
  onRange,
}: {
  analyte: Analyte;
  range: HeroRange;
  onRange: (r: HeroRange) => void;
}) {
  const days = RANGE_DAYS[range];
  const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : undefined;
  const pts = cutoff ? analyte.points.filter((p) => p.date >= cutoff) : analyte.points;
  const valColor = analyte.outOfRange ? T.outOfRange : T.ink;
  const delta = twelveMoDelta(analyte.points);
  const meta = `${fmtMonthDate(analyte.latest.date)}${delta ? ` · ${delta}` : ''}`;

  // y-domain: reference range padded ±40% of its width, expanded to include min/max points
  const pad =
    analyte.low != null && analyte.high != null ? (analyte.high - analyte.low) * 0.4 : undefined;
  const domain: [number | string, number | string] =
    analyte.low != null && analyte.high != null && pad != null && pts.length > 0
      ? [
          Math.min(analyte.low - pad, Math.min(...pts.map((p) => p.value))),
          Math.max(analyte.high + pad, Math.max(...pts.map((p) => p.value))),
        ]
      : ['auto', 'auto'];

  const renderDot = (props: {
    cx?: number;
    cy?: number;
    index?: number;
    payload?: { value: number };
  }) => {
    const { cx, cy, index } = props;
    if (cx == null || cy == null || index == null) {
      return <g key={`dot-${index}`} />;
    }
    if (index !== pts.length - 1) {
      return <circle key={`dot-${index}`} cx={cx} cy={cy} r={3} fill={T.ink} />;
    }
    return (
      <g key={`dot-${index}`}>
        <circle cx={cx} cy={cy} r={4} fill={valColor} />
        <text x={cx + 10} y={cy - 6} fontFamily={T.mono} fontSize={11} fill={T.ink}>
          {props.payload?.value ?? 0}
        </text>
      </g>
    );
  };

  return (
    <DsCard padding="22px 26px" gap={14}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <StatusDot color={T.metric.labs} size={8} />
        <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-.015em' }}>
          {analyte.name}{' '}
          {analyte.unit ? <span style={mono(12, 400, T.tertiary)}>{analyte.unit}</span> : null}
        </span>
        <span style={{ marginLeft: 6, display: 'flex', alignItems: 'baseline', gap: 5 }}>
          <span style={{ ...mono(24, 500, valColor), letterSpacing: '-.02em' }}>
            {analyte.latest.value}
          </span>
          <span style={mono(10.5, 400, T.tertiary)}>{meta}</span>
        </span>
        <div style={{ marginLeft: 'auto' }}>
          <SegmentedPills options={RANGE_OPTIONS} value={range} onChange={onRange} />
        </div>
      </div>

      {pts.length === 0 ? (
        <div style={{ height: 150, display: 'flex', alignItems: 'center' }}>
          <span style={mono(12, 400, T.tertiary)}>No draws in this window</span>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={150}>
          <LineChart data={pts} margin={{ top: 16, right: 46, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => fmtTick(d, range === '1Y')}
              tick={{ fontFamily: T.mono, fontSize: 10, fill: T.quaternary }}
              axisLine={false}
              tickLine={false}
              minTickGap={28}
            />
            <YAxis
              domain={domain as [number, number]}
              width={36}
              tickFormatter={(v: number) => fmtNum(v)}
              tick={{ fontFamily: T.mono, fontSize: 10, fill: T.quaternary }}
              axisLine={false}
              tickLine={false}
              tickCount={4}
            />
            <ChartTooltip
              cursor={{ stroke: T.hairline }}
              contentStyle={{
                background: T.card,
                border: 'none',
                borderRadius: 10,
                boxShadow: T.shadowCard,
                fontFamily: T.mono,
                fontSize: 11,
                padding: '8px 12px',
              }}
              labelStyle={{ color: T.tertiary, fontFamily: T.mono, fontSize: 10 }}
              itemStyle={{ color: T.ink }}
            />
            {analyte.low != null && analyte.high != null && (
              <ReferenceArea
                y1={analyte.low}
                y2={analyte.high}
                fill={T.band}
                fillOpacity={1}
                label={{
                  value: `REF ${analyte.low}–${analyte.high}`,
                  position: 'insideTopLeft',
                  fontFamily: T.mono,
                  fontSize: 10,
                  fill: T.quaternary,
                }}
              />
            )}
            <Line
              type="monotone"
              dataKey="value"
              name={analyte.name}
              unit={analyte.unit ? ` ${analyte.unit}` : ''}
              stroke={T.ink}
              strokeWidth={2.2}
              strokeLinecap="round"
              dot={renderDot}
              activeDot={{ r: 4, fill: valColor, stroke: 'none' }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}

      <div style={{ display: 'flex', gap: 16, ...mono(10, 400, T.tertiary) }}>
        <span style={{ color: T.ink }}>
          — measured · {pts.length} {pts.length === 1 ? 'draw' : 'draws'}
        </span>
        {analyte.low != null && analyte.high != null ? <span>▬ lab ref range</span> : null}
      </div>
    </DsCard>
  );
}

// ---------------------------------------------------------------------------
// Panel cards
// ---------------------------------------------------------------------------

function panelFor(name: string): string {
  for (const def of PANEL_DEFS) {
    if (def.match.test(name)) return def.name;
  }
  return OTHER_PANEL;
}

function buildPanels(analytes: Analyte[]): LabPanel[] {
  const byPanel = new Map<string, Analyte[]>();
  for (const a of analytes) {
    const p = panelFor(a.name);
    byPanel.set(p, [...(byPanel.get(p) ?? []), a]);
  }
  const order = [...PANEL_DEFS.map((d) => d.name), OTHER_PANEL];
  return order
    .filter((n) => byPanel.has(n))
    .map((n) => ({ name: n, analytes: byPanel.get(n) as Analyte[] }));
}

function PanelGrid({
  panels,
  onSelect,
  onHistory,
}: {
  panels: LabPanel[];
  onSelect: (name: string) => void;
  onHistory: () => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
      {panels.map((p) => (
        <PanelCard key={p.name} panel={p} onSelect={onSelect} onHistory={onHistory} />
      ))}
    </div>
  );
}

function PanelCard({
  panel,
  onSelect,
  onHistory,
}: {
  panel: LabPanel;
  onSelect: (name: string) => void;
  onHistory: () => void;
}) {
  const latestDate = panel.analytes.reduce(
    (m, a) => (a.latest.date > m ? a.latest.date : m),
    panel.analytes[0].latest.date
  );
  const above = panel.analytes.filter((a) => a.high != null && a.latest.value > a.high).length;
  const below = panel.analytes.filter((a) => a.low != null && a.latest.value < a.low).length;
  const parts: string[] = [];
  if (above > 0) parts.push(`${above} ABOVE REF`);
  if (below > 0) parts.push(`${below} BELOW REF`);
  const statusColor = parts.length > 0 ? T.outOfRange : T.inRange;
  const statusLabel = parts.length > 0 ? parts.join(' · ') : 'ALL IN RANGE';
  const results = panel.analytes.reduce((n, a) => n + a.points.length, 0);

  return (
    <DsCard flush gap={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 22px 10px' }}>
        <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: '-.01em' }}>{panel.name}</span>
        <span style={mono(10, 400, T.quaternary)}>{fmtDayDate(latestDate)}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
          <StatusDot color={statusColor} size={6} />
          <span style={mono(9.5, 500, statusColor)}>{statusLabel}</span>
        </span>
      </div>

      {panel.analytes.map((a) => {
        const valColor = a.outOfRange ? T.outOfRange : T.ink;
        return (
          <div
            key={a.name}
            role="button"
            tabIndex={0}
            title="Show trend"
            onClick={() => onSelect(a.name)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(a.name);
            }}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.3fr auto 1fr auto',
              gap: 14,
              alignItems: 'center',
              padding: '10px 22px',
              borderTop: `1px solid ${T.band}`,
              cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-.01em' }}>{a.name}</span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <span style={mono(14, 500, valColor)}>{a.latest.value}</span>
              {a.unit ? <span style={mono(9.5, 400, T.quaternary)}>{a.unit}</span> : null}
            </span>
            <RangeBar analyte={a} value={a.latest.value} color={valColor} />
            <span style={mono(9.5, 400, T.quaternary)}>{trendNote(a)}</span>
          </div>
        );
      })}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '11px 22px',
          background: T.cardFooter,
          borderTop: `1px solid ${T.band}`,
        }}
      >
        <span style={mono(10, 400, T.tertiary)}>
          {results} {results === 1 ? 'result' : 'results'} · {panel.analytes.length}{' '}
          {panel.analytes.length === 1 ? 'analyte' : 'analytes'}
        </span>
        <button
          type="button"
          onClick={onHistory}
          style={{
            marginLeft: 'auto',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: 0,
            fontFamily: 'inherit',
            fontSize: 12,
            fontWeight: 500,
            color: T.green,
          }}
        >
          History →
        </button>
      </div>
    </DsCard>
  );
}

/** 120×16 range-position bar: whisper track, green-tinted ref segment, status-colored value dot. */
function RangeBar({ analyte, value, color }: { analyte: Analyte; value: number; color: string }) {
  const vals = analyte.points.map((p) => p.value);
  const lo = analyte.low ?? Math.min(...vals, value);
  const hi = analyte.high ?? Math.max(...vals, value);
  const span = hi - lo;
  const pad = span > 0 ? span * 0.4 : Math.max(Math.abs(hi) * 0.4, 1);
  const min = lo - pad;
  const max = hi + pad;
  const toX = (v: number) => ((v - min) / (max - min)) * 120;
  const hasRef = analyte.low != null || analyte.high != null;
  const refX = analyte.low != null ? toX(analyte.low) : 0;
  const refEnd = analyte.high != null ? toX(analyte.high) : 120;
  const dotX = Math.min(116, Math.max(4, toX(value)));
  return (
    <svg viewBox="0 0 120 16" style={{ width: 120, height: 16, display: 'block' }}>
      <rect x={0} y={4} width={120} height={8} rx={4} fill={T.band} />
      {hasRef ? (
        <rect x={refX} y={4} width={Math.max(refEnd - refX, 0)} height={8} rx={4} fill="#e4efe9" />
      ) : null}
      <circle cx={dotX} cy={8} r={3.4} fill={color} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// By-date view
// ---------------------------------------------------------------------------

function ByDateCard({
  analytes,
  onSelect,
}: {
  analytes: Analyte[];
  onSelect: (name: string) => void;
}) {
  const rows = analytes
    .flatMap((a) => a.points.map((p) => ({ analyte: a, date: p.date, value: p.value })))
    .sort((x, y) => y.date.localeCompare(x.date));
  const shown = rows.slice(0, 100);
  return (
    <DsCard flush gap={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 22px 10px' }}>
        <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: '-.01em' }}>
          All results by date
        </span>
        <span style={mono(10, 400, T.quaternary)}>
          {shown.length < rows.length
            ? `latest ${shown.length} of ${rows.length}`
            : `${rows.length} ${rows.length === 1 ? 'result' : 'results'}`}
        </span>
      </div>
      {shown.map((r, i) => {
        const out =
          (r.analyte.low != null && r.value < r.analyte.low) ||
          (r.analyte.high != null && r.value > r.analyte.high);
        const color = out ? T.outOfRange : T.ink;
        return (
          <div
            key={`${r.analyte.name}-${r.date}-${i}`}
            role="button"
            tabIndex={0}
            title="Show trend"
            onClick={() => onSelect(r.analyte.name)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(r.analyte.name);
            }}
            style={{
              display: 'grid',
              gridTemplateColumns: '92px 1.3fr auto 1fr',
              gap: 14,
              alignItems: 'center',
              padding: '10px 22px',
              borderTop: `1px solid ${T.band}`,
              cursor: 'pointer',
            }}
          >
            <span style={mono(10.5, 400, T.tertiary)}>{fmtDayDate(r.date)}</span>
            <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-.01em' }}>
              {r.analyte.name}
            </span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <span style={mono(14, 500, color)}>{r.value}</span>
              {r.analyte.unit ? (
                <span style={mono(9.5, 400, T.quaternary)}>{r.analyte.unit}</span>
              ) : null}
            </span>
            <RangeBar analyte={r.analyte} value={r.value} color={color} />
          </div>
        );
      })}
    </DsCard>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-03-12' → 'Mar 12 2026' */
function fmtDayDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d} ${y}`;
}

/** '2026-03-12' → 'Mar 2026' */
function fmtMonthDate(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  if (!y || !m) return iso;
  return `${MONTHS[m - 1]} ${y}`;
}

/** axis tick: 'Mar 12' inside a 1Y window, 'Mar ’26' otherwise */
function fmtTick(iso: string, withDay: boolean): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m) return iso;
  return withDay ? `${MONTHS[m - 1]} ${d}` : `${MONTHS[m - 1]} ’${String(y).slice(2)}`;
}

function fmtNum(v: number): string {
  return parseFloat(v.toFixed(2)).toString();
}

function spanText(minDate: string, maxDate: string): string {
  const days = Math.round((new Date(maxDate).getTime() - new Date(minDate).getTime()) / 86400000);
  if (days >= 730) return `${Math.round(days / 365.25)} years`;
  if (days >= 62) return `${Math.round(days / 30.44)} months`;
  return `${Math.max(days, 1)} ${days === 1 ? 'day' : 'days'}`;
}

/** '▾0.4 in 12 mo' — latest vs the most recent draw at least 12 months older; undefined if none. */
function twelveMoDelta(points: { date: string; value: number }[]): string | undefined {
  const latest = points[points.length - 1];
  const cutoff = new Date(new Date(`${latest.date}T12:00:00`).getTime() - 365 * 86400000)
    .toISOString()
    .slice(0, 10);
  const base = [...points].reverse().find((p) => p.date <= cutoff);
  if (!base) return undefined;
  const d = latest.value - base.value;
  const glyph = d < 0 ? '▾' : d > 0 ? '▴' : '→';
  return `${glyph}${fmtNum(Math.abs(d))} in 12 mo`;
}

/** Trend vs the previous draw — fixed glyph vocabulary ▾ ▴ →, no clinical judgment. */
function trendNote(a: Analyte): string {
  if (a.points.length < 2) return 'first result';
  const prev = a.points[a.points.length - 2].value;
  const d = a.latest.value - prev;
  if (d === 0) return '→ steady';
  return d > 0 ? `▴ up ${fmtNum(d)}` : `▾ down ${fmtNum(-d)}`;
}
