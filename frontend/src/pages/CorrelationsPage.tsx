import { Loader, Select, Switch } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconInfoCircle } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Chip, ConfidenceBar, DsCard, Eyebrow, PageHeader, StatusDot } from '../components/ds';
import { T, mono } from '../tokens';

/**
 * Correlation explorer: pick any two tracked metrics, see the scatter and a
 * Pearson coefficient, optionally with X leading Y by one day. Associations
 * only — the mandatory framing label is rendered on the page (spec SR-6).
 *
 * Everything on this page is computed locally (plain statistics) — no AI
 * content, so no indigo/✦ treatment appears here.
 */

interface SeriesMap {
  [key: string]: { label: string; byDate: Map<string, number> };
}

/** Strength word → neutral ink-scale color (measured/computed data class). */
const STRENGTH_COLOR: Record<string, string> = {
  negligible: T.quaternary,
  weak: T.tertiary,
  moderate: T.secondary,
  strong: T.ink,
};

/** Metric accent for data-viz only (dots, strength bar) — fallback brand green. */
function accentFor(key: string | null, label: string | undefined): string {
  const s = `${key ?? ''} ${label ?? ''}`.toLowerCase();
  if (/sleep/.test(s)) return T.metric.sleep;
  if (/mood/.test(s)) return T.metric.mood;
  if (/energy/.test(s)) return T.metric.energy;
  if (/heart|pulse|\bhr\b/.test(s)) return T.metric.heart;
  if (/glucose/.test(s)) return T.metric.glucose;
  if (/weight|\bbmi\b|body mass/.test(s)) return T.metric.weight;
  if (/blood.pressure|systolic|diastolic|\bbp\b/.test(s)) return T.metric.bp;
  if (/step|walk|exercise|activity|workout/.test(s)) return T.metric.activity;
  if (/respir|breath|spo2|oxygen/.test(s)) return T.metric.respiratory;
  return T.green;
}

const selectStyles = {
  label: {
    ...mono(10, 500, T.quaternary),
    textTransform: 'uppercase' as const,
    letterSpacing: '.12em',
    marginBottom: 6,
  },
};

export function CorrelationsPage() {
  const medplum = useMedplum();
  const [seriesMap, setSeriesMap] = useState<SeriesMap>();
  const [xKey, setXKey] = useState<string | null>(null);
  const [yKey, setYKey] = useState<string | null>(null);
  const [lag, setLag] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    (async () => {
      try {
        const since = new Date();
        since.setDate(since.getDate() - 365);
        const observations = await medplum.searchResources('Observation', {
          date: `ge${since.toISOString().slice(0, 10)}`,
          _count: '1000',
          _sort: '-date',
        });
        const map: SeriesMap = {};
        for (const obs of observations) {
          const coding = obs.code?.coding?.[0];
          const key = coding?.code;
          if (!key) continue;
          const label = obs.code?.text ?? coding?.display ?? key;
          const date = (obs.effectiveDateTime ?? obs.effectivePeriod?.end ?? '').slice(0, 10);
          const value = obs.valueQuantity?.value ?? obs.valueInteger;
          if (!date || value == null) continue;
          map[key] = map[key] ?? { label, byDate: new Map() };
          // newest first — keep the latest value per day
          if (!map[key].byDate.has(date)) map[key].byDate.set(date, value);
        }
        const filtered: SeriesMap = {};
        for (const [key, s] of Object.entries(map)) {
          if (s.byDate.size >= 3) filtered[key] = s;
        }
        setSeriesMap(filtered);
        const keys = Object.keys(filtered);
        setXKey(keys.includes('sleep-duration') ? 'sleep-duration' : (keys[0] ?? null));
        setYKey(keys.includes('mood') ? 'mood' : (keys[1] ?? null));
      } catch (err) {
        setError(normalizeErrorString(err));
      }
    })();
  }, [medplum]);

  const result = useMemo(() => {
    if (!seriesMap || !xKey || !yKey) return undefined;
    const xs = seriesMap[xKey];
    const ys = seriesMap[yKey];
    if (!xs || !ys) return undefined;
    const points: { x: number; y: number; date: string }[] = [];
    for (const [date, x] of xs.byDate) {
      const target = lag ? shiftDate(date, 1) : date;
      const y = ys.byDate.get(target);
      if (y !== undefined) points.push({ x, y, date });
    }
    return { points, r: pearson(points) };
  }, [seriesMap, xKey, yKey, lag]);

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <PageHeader title="Correlations" subtitle="pair any two metrics · Pearson r · computed locally" />
        <DsCard padding="18px 22px" gap={6}>
          <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: '-.01em' }}>
            Could not load metrics
          </span>
          <span style={mono(11.5, 400, T.outOfRange)}>{error}</span>
        </DsCard>
      </div>
    );
  }
  if (!seriesMap) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '96px 0' }}>
        <Loader />
      </div>
    );
  }

  const options = Object.entries(seriesMap)
    .map(([value, s]) => ({ value, label: `${s.label} (${s.byDate.size}d)` }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const xSeries = xKey ? seriesMap[xKey] : undefined;
  const ySeries = yKey ? seriesMap[yKey] : undefined;
  const accent = accentFor(xKey, xSeries?.label);
  const hasResult = !!result && result.points.length >= 3;
  const strength = hasResult
    ? Math.abs(result.r) < 0.2
      ? 'negligible'
      : Math.abs(result.r) < 0.5
        ? 'weak'
        : Math.abs(result.r) < 0.8
          ? 'moderate'
          : 'strong'
    : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Correlations"
        subtitle={`${options.length} metrics with ≥3 days · 365-day window · computed locally — no AI`}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* SR-6 mandatory framing — association, not causation */}
        <DsCard padding="14px 22px" gap={0} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <IconInfoCircle size={16} stroke={1.7} color={T.tertiary} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 13, lineHeight: 1.55, color: T.secondary }}>
            <strong style={{ fontWeight: 600, color: T.ink }}>Association, not causation</strong> — and not
            medical advice. Patterns here are prompts for a conversation with your clinician, nothing more.
          </span>
        </DsCard>

        {/* Metric pickers + lag toggle */}
        <DsCard padding="18px 22px" gap={0}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
            <Select
              label="X metric"
              data={options}
              value={xKey}
              onChange={setXKey}
              searchable
              w={260}
              styles={selectStyles}
            />
            <Select
              label="Y metric"
              data={options}
              value={yKey}
              onChange={setYKey}
              searchable
              w={260}
              styles={selectStyles}
            />
            <Switch
              label="X today vs Y tomorrow (1-day lag)"
              checked={lag}
              onChange={(e) => setLag(e.currentTarget.checked)}
              styles={{
                root: { paddingBottom: 8 },
                label: { fontSize: 12.5, fontWeight: 500, color: T.secondary },
              }}
            />
          </div>
        </DsCard>

        {/* Result — local statistical insight card */}
        {!hasResult || !result || !strength ? (
          <DsCard padding="30px 24px" gap={0} style={{ alignItems: 'center' }}>
            <span style={{ ...mono(12, 400, T.quaternary), textAlign: 'center' }}>
              Not enough overlapping days for these two metrics — log both for a few days.
            </span>
          </DsCard>
        ) : (
          <DsCard padding="22px 26px" gap={16}>
            {/* header row: strength tag + provenance meta */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span
                style={{
                  ...mono(10, 500, STRENGTH_COLOR[strength]),
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                }}
              >
                {strength}
              </span>
              <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>
                local · statistical · {result.points.length} paired days
              </span>
            </div>

            {/* headline: the pair under test */}
            <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-.015em', lineHeight: 1.35 }}>
              {xSeries?.label} × {ySeries?.label}
              {lag ? (
                <span style={{ ...mono(11, 400, T.quaternary), marginLeft: 10 }}>X today vs Y tomorrow</span>
              ) : null}
            </span>

            {/* big r value + strength bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
                <Eyebrow color={T.quaternary}>Pearson r</Eyebrow>
                <span style={mono(30, 500, T.ink)}>{result.r.toFixed(2)}</span>
              </div>
              <div style={{ flex: 1 }}>
                <ConfidenceBar
                  value={Math.abs(result.r)}
                  color={accent}
                  label="|r| strength"
                  valueLabel={`${strength} · ${Math.abs(result.r).toFixed(2)}`}
                />
              </div>
            </div>

            {/* canonical result line */}
            <span style={mono(11.5, 400, T.tertiary)}>
              {result.points.length} paired days · Pearson r ={' '}
              <span style={mono(11.5, 500, T.ink)}>{result.r.toFixed(2)}</span> ({strength} association)
            </span>

            <ResponsiveContainer width="100%" height={320}>
              <ScatterChart margin={{ top: 8, right: 12, bottom: 8, left: 4 }}>
                <CartesianGrid stroke={T.chip} />
                <XAxis
                  dataKey="x"
                  name={seriesMap[xKey!]?.label}
                  type="number"
                  domain={['auto', 'auto']}
                  tick={{ fontSize: 10, fill: T.quaternary, fontFamily: T.mono }}
                  tickLine={false}
                  axisLine={false}
                  label={{
                    value: seriesMap[xKey!]?.label,
                    position: 'insideBottom',
                    offset: -4,
                    fontSize: 10,
                    fill: T.quaternary,
                    fontFamily: T.mono,
                  }}
                />
                <YAxis
                  dataKey="y"
                  name={seriesMap[yKey!]?.label}
                  type="number"
                  domain={['auto', 'auto']}
                  tick={{ fontSize: 10, fill: T.quaternary, fontFamily: T.mono }}
                  tickLine={false}
                  axisLine={false}
                  label={{
                    value: seriesMap[yKey!]?.label,
                    angle: -90,
                    position: 'insideLeft',
                    fontSize: 10,
                    fill: T.quaternary,
                    fontFamily: T.mono,
                  }}
                />
                <ChartTooltip
                  content={({ payload }) =>
                    payload?.[0] ? (
                      <div
                        style={{
                          background: T.card,
                          borderRadius: 10,
                          padding: '7px 11px',
                          boxShadow: T.shadowCard,
                        }}
                      >
                        <span style={mono(10.5, 400, T.ink)}>
                          {(payload[0].payload as { date: string }).date}: x={payload[0].payload.x}, y=
                          {payload[0].payload.y}
                        </span>
                      </div>
                    ) : null
                  }
                />
                <Scatter data={result.points} fill={accent} />
              </ScatterChart>
            </ResponsiveContainer>

            {/* evidence counts */}
            <div
              style={{
                borderTop: `1px solid ${T.band}`,
                paddingTop: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <Eyebrow color={T.quaternary}>Evidence · 2 series</Eyebrow>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Chip>
                  <StatusDot color={accent} size={7} />
                  {xSeries?.label} · {xSeries?.byDate.size}d
                </Chip>
                <Chip>
                  <StatusDot color={accentFor(yKey, ySeries?.label)} size={7} />
                  {ySeries?.label} · {ySeries?.byDate.size}d
                </Chip>
                <Chip>paired · {result.points.length}d</Chip>
              </div>
            </div>
          </DsCard>
        )}
      </div>
    </div>
  );
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pearson(points: { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    dx2 += (p.x - mx) ** 2;
    dy2 += (p.y - my) ** 2;
  }
  const denominator = Math.sqrt(dx2 * dy2);
  return denominator === 0 ? 0 : num / denominator;
}
