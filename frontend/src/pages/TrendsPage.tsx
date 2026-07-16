import { Alert, Loader, Menu } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconDownload } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CardTitle, DsCard, PageHeader, PillButton, SegmentedPills, StatusDot } from '../components/ds';
import { CS_OBS, LOINC } from '../fhir';
import { T, mono } from '../tokens';

interface Point {
  /** epoch ms of the observation — the chart x value */
  t: number;
  /** raw FHIR effective timestamp, exactly as stored */
  at: string;
  value: number;
}

interface Series {
  weight: Point[];
  sleep: Point[];
  mood: Point[];
  energy: Point[];
}

type MetricKey = keyof Series;

interface MetricDef {
  key: MetricKey;
  label: string;
  /** chip label suffix, e.g. 'Weight · kg' */
  unit: string;
  /** unit rendered next to values */
  unitShort: string;
  /** metric accent (data-viz only) */
  color: string;
  decimals: number;
  csv: string;
  /** absolute Y-axis domain — fixed scales per the data contract, never normalized */
  domain: [number | 'auto', number | 'auto'];
  yTicks?: number[];
}

const METRICS: MetricDef[] = [
  {
    key: 'weight',
    label: 'Weight',
    unit: 'kg',
    unitShort: 'kg',
    color: T.metric.weight,
    decimals: 1,
    csv: 'weight_kg',
    domain: ['auto', 'auto'],
  },
  {
    key: 'sleep',
    label: 'Sleep',
    unit: 'hours',
    unitShort: 'h',
    color: T.metric.sleep,
    decimals: 1,
    csv: 'sleep_h',
    domain: [0, 12],
    yTicks: [0, 6, 12],
  },
  {
    key: 'mood',
    label: 'Mood',
    unit: '1–10',
    unitShort: '/10',
    color: T.metric.mood,
    decimals: 0,
    csv: 'mood',
    domain: [0, 10],
    yTicks: [0, 5, 10],
  },
  {
    key: 'energy',
    label: 'Energy',
    unit: '1–10',
    unitShort: '/10',
    color: T.metric.energy,
    decimals: 0,
    csv: 'energy',
    domain: [0, 10],
    yTicks: [0, 5, 10],
  },
];

const VIEWS: { name: string; keys: MetricKey[] }[] = [
  { name: 'All signals', keys: ['weight', 'sleep', 'mood', 'energy'] },
  { name: 'Weight × sleep', keys: ['weight', 'sleep'] },
  { name: 'Mood × energy', keys: ['mood', 'energy'] },
  { name: 'Sleep × mood', keys: ['sleep', 'mood'] },
];

const WINDOW_LABEL: Record<string, string> = { '30': '30 days', '90': '90 days', '365': '1 year' };

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Epoch ms for a FHIR instant; date-only values parse as local midnight. */
function toEpoch(iso: string): number {
  if (iso.length === 10) {
    return new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))).getTime();
  }
  return new Date(iso).getTime();
}

/** epoch ms → 'APR 16' in local time */
function fmtTick(t: number): string {
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Tooltip timestamp: 'APR 16 · 07:05' local 24h (day only when the source had no time part). */
function fmtWhen(p: Point): string {
  const d = new Date(p.t);
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (p.at.length <= 10) {
    return day;
  }
  return `${day} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtVal(v: number, decimals: number): string {
  return Number(v.toFixed(decimals)).toString();
}

export function TrendsPage() {
  const medplum = useMedplum();
  const [windowDays, setWindowDays] = useState('90');
  const [series, setSeries] = useState<Series>();
  const [range, setRange] = useState<{ start: number; end: number }>();
  const [error, setError] = useState<string>();
  const [hidden, setHidden] = useState<MetricKey[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setSeries(undefined);
        const since = new Date();
        since.setDate(since.getDate() - Number(windowDays));
        const observations = await medplum.searchResources('Observation', {
          date: `ge${since.toISOString().slice(0, 10)}`,
          _count: '1000',
          _sort: 'date',
        });
        const next: Series = { weight: [], sleep: [], mood: [], energy: [] };
        for (const obs of observations) {
          const coding = obs.code?.coding?.[0];
          const at = obs.effectiveDateTime ?? obs.effectivePeriod?.end ?? '';
          if (!at) continue;
          const t = toEpoch(at);
          if (Number.isNaN(t)) continue;
          if (coding?.system === LOINC && coding.code === '29463-7' && obs.valueQuantity?.value != null) {
            next.weight.push({ t, at, value: obs.valueQuantity.value });
          } else if (coding?.system === CS_OBS && coding.code === 'sleep-duration' && obs.valueQuantity?.value != null) {
            next.sleep.push({ t, at, value: obs.valueQuantity.value });
          } else if (coding?.system === CS_OBS && coding.code === 'mood' && obs.valueInteger != null) {
            next.mood.push({ t, at, value: obs.valueInteger });
          } else if (coding?.system === CS_OBS && coding.code === 'energy' && obs.valueInteger != null) {
            next.energy.push({ t, at, value: obs.valueInteger });
          }
        }
        for (const m of METRICS) {
          next[m.key].sort((a, b) => a.t - b.t);
        }
        if (!cancelled) {
          setSeries(next);
          setRange({ start: since.getTime(), end: Date.now() });
        }
      } catch (err) {
        if (!cancelled) setError(normalizeErrorString(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [medplum, windowDays]);

  const shownMetrics = METRICS.filter((m) => !hidden.includes(m.key));
  const hiddenMetrics = METRICS.filter((m) => hidden.includes(m.key));

  const stats = useMemo(() => {
    if (!series) {
      return undefined;
    }
    const out = {} as Record<MetricKey, { n: number; min: number; max: number; latest?: Point }>;
    for (const m of METRICS) {
      const pts = series[m.key];
      let min = Infinity;
      let max = -Infinity;
      for (const p of pts) {
        min = Math.min(min, p.value);
        max = Math.max(max, p.value);
      }
      out[m.key] = { n: pts.length, min, max, latest: pts[pts.length - 1] };
    }
    return out;
  }, [series]);

  // Shared time axis for the metric charts: the query window, widened to cover
  // any point the UTC-sliced `ge` bound let through just outside it.
  const xDomain = useMemo(() => {
    if (!series || !range) {
      return undefined;
    }
    let start = range.start;
    let end = range.end;
    for (const m of METRICS) {
      for (const p of series[m.key]) {
        start = Math.min(start, p.t);
        end = Math.max(end, p.t);
      }
    }
    return [start, end] as [number, number];
  }, [series, range]);

  const xTicks = useMemo(
    () => (xDomain ? [xDomain[0], (xDomain[0] + xDomain[1]) / 2, xDomain[1]] : undefined),
    [xDomain]
  );

  /** One CSV row per observation, full timestamp as stored — never collapsed by day. */
  function exportView(): void {
    if (!series) {
      return;
    }
    const active = METRICS.filter((m) => !hidden.includes(m.key));
    const rows: { t: number; at: string; metric: string; value: number }[] = [];
    for (const m of active) {
      for (const p of series[m.key]) {
        rows.push({ t: p.t, at: p.at, metric: m.csv, value: p.value });
      }
    }
    rows.sort((a, b) => a.t - b.t);
    const lines = ['timestamp,metric,value', ...rows.map((r) => `${r.at},${r.metric},${r.value}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trends-view-${windowDays}d.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Trends"
        subtitle="every signal on its own scale · find your own patterns"
        right={
          <PillButton
            variant="secondary"
            onClick={exportView}
            disabled={!series}
            style={{ padding: '9px 18px', display: 'flex', alignItems: 'center', gap: 7 }}
          >
            <IconDownload size={14} stroke={1.7} />
            Export view
          </PillButton>
        }
      />

      {error ? (
        <Alert color="red" title="Could not load trends">
          {error}
        </Alert>
      ) : (
        <>
          {/* Control row — signal chips + range control */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {shownMetrics.map((m) => (
              <span
                key={m.key}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  background: T.band,
                  borderRadius: 20,
                  padding: '6px 13px',
                }}
              >
                <StatusDot color={m.color} size={8} />
                <span style={mono(11.5, 500, T.ink)}>
                  {m.label} · {m.unit}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${m.label}`}
                  onClick={() => setHidden((h) => [...h, m.key])}
                  style={{
                    border: 'none',
                    background: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    fontSize: 11,
                    lineHeight: 1,
                    color: T.quaternary,
                  }}
                >
                  ✕
                </button>
              </span>
            ))}
            {hiddenMetrics.length > 0 ? (
              <Menu shadow="md" radius={12} position="bottom-start">
                <Menu.Target>
                  <button
                    type="button"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      border: '1px dashed #d9d9d5',
                      background: 'transparent',
                      borderRadius: 20,
                      padding: '6px 13px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 12,
                      fontWeight: 500,
                      color: T.secondary,
                    }}
                  >
                    ＋ Add signal
                  </button>
                </Menu.Target>
                <Menu.Dropdown>
                  {hiddenMetrics.map((m) => (
                    <Menu.Item
                      key={m.key}
                      leftSection={<StatusDot color={m.color} size={8} />}
                      onClick={() => setHidden((h) => h.filter((k) => k !== m.key))}
                    >
                      <span style={mono(11.5, 500, T.ink)}>
                        {m.label} · {m.unit}
                      </span>
                    </Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
            ) : null}
            <div style={{ marginLeft: 'auto' }}>
              <SegmentedPills
                options={[
                  { value: '30', label: '30D' },
                  { value: '90', label: '90D' },
                  { value: '365', label: '1Y' },
                ]}
                value={windowDays}
                onChange={setWindowDays}
              />
            </div>
          </div>

          {/* Metric charts — one card per signal, absolute scales */}
          {!series || !xDomain || !xTicks ? (
            <DsCard padding="22px 26px">
              <div style={{ height: 220, display: 'grid', placeItems: 'center' }}>
                <Loader color="hmdGreen" size="sm" />
              </div>
            </DsCard>
          ) : shownMetrics.length === 0 ? (
            <DsCard padding="22px 26px">
              <div
                style={{
                  height: 120,
                  display: 'grid',
                  placeItems: 'center',
                  ...mono(11, 400, T.quaternary),
                }}
              >
                No signals — add one to plot.
              </div>
            </DsCard>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
                gap: 16,
                alignItems: 'start',
              }}
            >
              {shownMetrics.map((m) => (
                <MetricCard
                  key={m.key}
                  metric={m}
                  points={series[m.key]}
                  xDomain={xDomain}
                  xTicks={xTicks}
                  latest={stats?.[m.key]?.latest}
                />
              ))}
            </div>
          )}

          {/* Bottom grid — window summary + views */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 16, alignItems: 'start' }}>
            <DsCard flush gap={0}>
              <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px 10px' }}>
                <CardTitle size={14.5}>In this window</CardTitle>
                <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>
                  {WINDOW_LABEL[windowDays]}
                </span>
              </div>
              {METRICS.map((m) => {
                const s = stats?.[m.key];
                const has = s !== undefined && s.n > 0;
                return (
                  <div
                    key={m.key}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '10px 1fr auto',
                      gap: 12,
                      alignItems: 'center',
                      padding: '11px 20px',
                      borderTop: `1px solid ${T.band}`,
                    }}
                  >
                    <StatusDot color={m.color} size={8} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-.01em' }}>{m.label}</span>
                      <span style={mono(10, 400, T.quaternary)}>
                        {has
                          ? `${s.n} points · ${fmtVal(s.min, m.decimals)}–${fmtVal(s.max, m.decimals)} ${m.unitShort}`
                          : 'no data in this window'}
                      </span>
                    </div>
                    {has && s.latest ? (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                        <span style={mono(13, 500, T.ink)}>
                          {fmtVal(s.latest.value, m.decimals)} {m.unitShort}
                        </span>
                        <span style={mono(9.5, 400, T.quaternary)}>{fmtTick(s.latest.t)}</span>
                      </div>
                    ) : (
                      <span style={mono(10, 400, T.quaternary)}>—</span>
                    )}
                  </div>
                );
              })}
            </DsCard>

            <DsCard flush gap={0}>
              <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px 10px' }}>
                <CardTitle size={14.5}>Views</CardTitle>
                <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>{VIEWS.length}</span>
              </div>
              {VIEWS.map((v) => {
                const current =
                  v.keys.length === shownMetrics.length && v.keys.every((k) => !hidden.includes(k));
                const pts = series ? v.keys.reduce((sum, k) => sum + series[k].length, 0) : undefined;
                return (
                  <ViewRow
                    key={v.name}
                    name={v.name}
                    meta={`${v.keys.length} signals${pts !== undefined ? ` · ${pts} pts` : ''}${current ? ' · current' : ''}`}
                    dots={v.keys.map((k) => METRICS.find((m) => m.key === k)?.color ?? T.quaternary)}
                    onClick={() => setHidden(METRICS.map((m) => m.key).filter((k) => !v.keys.includes(k)))}
                  />
                );
              })}
            </DsCard>
          </div>
        </>
      )}
    </div>
  );
}

/** One signal, one chart: absolute Y domain (mood/energy 0–10, sleep 0–12, weight auto),
 *  every observation plotted at its own timestamp — same-day readings are never merged. */
function MetricCard(props: {
  metric: MetricDef;
  points: Point[];
  xDomain: [number, number];
  xTicks: number[];
  latest?: Point;
}) {
  const { metric: m, points } = props;
  return (
    <DsCard padding="18px 20px" gap={10}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusDot color={m.color} size={8} />
        <CardTitle size={14}>{m.label}</CardTitle>
        <span style={mono(10, 400, T.quaternary)}>{m.unit}</span>
        {props.latest ? (
          <span style={{ marginLeft: 'auto', ...mono(11.5, 500, T.ink) }}>
            {fmtVal(props.latest.value, m.decimals)} {m.unitShort}
          </span>
        ) : null}
      </div>
      {points.length === 0 ? (
        <div
          style={{
            height: 200,
            display: 'grid',
            placeItems: 'center',
            ...mono(11, 400, T.quaternary),
          }}
        >
          No data in this window.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={points} margin={{ top: 8, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid horizontal vertical={false} stroke={T.chip} />
            <XAxis
              dataKey="t"
              type="number"
              domain={props.xDomain}
              ticks={props.xTicks}
              tickFormatter={fmtTick}
              axisLine={false}
              tickLine={false}
              tick={{ fontFamily: T.mono, fontSize: 9, fill: T.quaternary }}
              tickMargin={10}
            />
            <YAxis
              domain={m.domain}
              ticks={m.yTicks}
              width={40}
              tickFormatter={(v: number) => `${Math.round(v * 100) / 100}`}
              axisLine={false}
              tickLine={false}
              tick={{ fontFamily: T.mono, fontSize: 9, fill: T.quaternary }}
            />
            <ChartTooltip
              content={<MetricTooltip metric={m} />}
              cursor={{ stroke: T.hairline, strokeDasharray: '3 4' }}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke={m.color}
              strokeWidth={2.2}
              strokeLinecap="round"
              dot={points.length < 40 ? { r: 2.3, strokeWidth: 0, fill: m.color } : false}
              activeDot={{ r: 3, strokeWidth: 0 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </DsCard>
  );
}

/** Saved-view style row: name + mono meta, dot cluster, hover tint, click to apply. */
function ViewRow(props: { name: string; meta: string; dots: string[]; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 12,
        alignItems: 'center',
        padding: '11px 20px',
        borderTop: `1px solid ${T.band}`,
        borderLeft: 'none',
        borderRight: 'none',
        borderBottom: 'none',
        background: hover ? T.cardFooter : 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        width: '100%',
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-.01em', color: T.ink }}>{props.name}</span>
        <span style={mono(10, 400, T.quaternary)}>{props.meta}</span>
      </span>
      <span style={{ display: 'flex', gap: 4 }}>
        {props.dots.map((c, i) => (
          <StatusDot key={i} color={c} size={7} />
        ))}
      </span>
    </button>
  );
}

/** DS tooltip: white card, mono values — each point's real value and its time. */
function MetricTooltip({
  active,
  payload,
  metric,
}: {
  active?: boolean;
  payload?: { payload?: Point }[];
  metric: MetricDef;
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p || typeof p.value !== 'number') {
    return null;
  }
  return (
    <div
      style={{
        background: T.card,
        borderRadius: 10,
        boxShadow: T.shadowCard,
        padding: '8px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <span style={mono(10, 500, T.tertiary)}>{fmtWhen(p)}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <StatusDot color={metric.color} size={7} />
        <span style={{ fontSize: 11.5, color: T.secondary }}>{metric.label}</span>
        <span style={{ marginLeft: 12, ...mono(11.5, 500, T.ink) }}>
          {fmtVal(p.value, metric.decimals)} {metric.unitShort}
        </span>
      </div>
    </div>
  );
}
