import { Alert, Card, Group, Loader, Select, Stack, Switch, Text, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
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

/**
 * Correlation explorer: pick any two tracked metrics, see the scatter and a
 * Pearson coefficient, optionally with X leading Y by one day. Associations
 * only — the mandatory framing label is rendered on the page (spec SR-6).
 */

interface SeriesMap {
  [key: string]: { label: string; byDate: Map<string, number> };
}

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
      <Alert color="red" title="Could not load metrics">
        {error}
      </Alert>
    );
  }
  if (!seriesMap) return <Loader />;

  const options = Object.entries(seriesMap)
    .map(([value, s]) => ({ value, label: `${s.label} (${s.byDate.size}d)` }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <Stack>
      <Title order={2}>Correlations</Title>
      <Alert color="gray" variant="light">
        Association, not causation — and not medical advice. Patterns here are prompts for a
        conversation with your clinician, nothing more.
      </Alert>
      <Card withBorder>
        <Group align="flex-end" mb="sm">
          <Select label="X metric" data={options} value={xKey} onChange={setXKey} searchable w={260} />
          <Select label="Y metric" data={options} value={yKey} onChange={setYKey} searchable w={260} />
          <Switch
            label="X today vs Y tomorrow (1-day lag)"
            checked={lag}
            onChange={(e) => setLag(e.currentTarget.checked)}
          />
        </Group>
        {!result || result.points.length < 3 ? (
          <Text c="dimmed">
            Not enough overlapping days for these two metrics — log both for a few days.
          </Text>
        ) : (
          <>
            <Text size="sm" mb="xs">
              {result.points.length} paired days · Pearson r = <b>{result.r.toFixed(2)}</b>{' '}
              <Text span c="dimmed">
                ({Math.abs(result.r) < 0.2 ? 'negligible' : Math.abs(result.r) < 0.5 ? 'weak' : Math.abs(result.r) < 0.8 ? 'moderate' : 'strong'}{' '}
                association)
              </Text>
            </Text>
            <ResponsiveContainer width="100%" height={320}>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="x"
                  name={seriesMap[xKey!]?.label}
                  fontSize={11}
                  type="number"
                  domain={['auto', 'auto']}
                  label={{ value: seriesMap[xKey!]?.label, position: 'insideBottom', offset: -4, fontSize: 12 }}
                />
                <YAxis
                  dataKey="y"
                  name={seriesMap[yKey!]?.label}
                  fontSize={11}
                  type="number"
                  domain={['auto', 'auto']}
                  label={{ value: seriesMap[yKey!]?.label, angle: -90, position: 'insideLeft', fontSize: 12 }}
                />
                <ChartTooltip
                  content={({ payload }) =>
                    payload?.[0] ? (
                      <Card withBorder p={6}>
                        <Text size="xs">
                          {(payload[0].payload as { date: string }).date}: x={payload[0].payload.x}, y=
                          {payload[0].payload.y}
                        </Text>
                      </Card>
                    ) : null
                  }
                />
                <Scatter data={result.points} fill="#0ca678" />
              </ScatterChart>
            </ResponsiveContainer>
          </>
        )}
      </Card>
    </Stack>
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
