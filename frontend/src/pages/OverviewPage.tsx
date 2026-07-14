import { Alert, Card, Group, Loader, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import type { Observation, QuestionnaireResponse } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CS_OBS, LOINC, adherenceStats, loadAdmins, loadMeds, summarizeDays } from '../fhir';

interface Point {
  date: string;
  value: number;
}

interface LabRow {
  name: string;
  date: string;
  value: string;
  range: string;
  flagged: boolean;
}

export function OverviewPage() {
  const medplum = useMedplum();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [weight, setWeight] = useState<Point[]>([]);
  const [mood, setMood] = useState<Point[]>([]);
  const [energy, setEnergy] = useState<Point[]>([]);
  const [sleep, setSleep] = useState<Point[]>([]);
  const [symptoms, setSymptoms] = useState<Observation[]>([]);
  const [labs, setLabs] = useState<LabRow[]>([]);
  const [checkin, setCheckin] = useState<QuestionnaireResponse>();
  const [summary, setSummary] = useState<string>('');

  useEffect(() => {
    (async () => {
      try {
        const since = new Date();
        since.setDate(since.getDate() - 90);
        const sinceStr = since.toISOString().slice(0, 10);

        const [observations, meds, admins, responses] = await Promise.all([
          medplum.searchResources('Observation', {
            date: `ge${sinceStr}`,
            _count: '1000',
            _sort: 'date',
          }),
          loadMeds(medplum),
          loadAdmins(medplum, 30),
          medplum.searchResources('QuestionnaireResponse', { _sort: '-authored', _count: '1' }),
        ]);

        const weightPts: Point[] = [];
        const moodPts: Point[] = [];
        const energyPts: Point[] = [];
        const sleepPts: Point[] = [];
        const symptomObs: Observation[] = [];
        const labRows: LabRow[] = [];

        for (const obs of observations) {
          const coding = obs.code?.coding?.[0];
          const when = (obs.effectiveDateTime ?? obs.effectivePeriod?.end ?? '').slice(0, 10);
          if (!when) continue;
          if (coding?.system === LOINC && coding.code === '29463-7' && obs.valueQuantity?.value != null) {
            weightPts.push({ date: when, value: obs.valueQuantity.value });
          } else if (coding?.system === CS_OBS && coding.code === 'mood' && obs.valueInteger != null) {
            moodPts.push({ date: when, value: obs.valueInteger });
          } else if (coding?.system === CS_OBS && coding.code === 'energy' && obs.valueInteger != null) {
            energyPts.push({ date: when, value: obs.valueInteger });
          } else if (coding?.system === CS_OBS && coding.code === 'sleep-duration' && obs.valueQuantity?.value != null) {
            sleepPts.push({ date: when, value: obs.valueQuantity.value });
          } else if (coding?.system === CS_OBS && coding.code === 'symptom') {
            symptomObs.push(obs);
          } else if (
            obs.category?.some((c) => c.coding?.some((cc) => cc.code === 'laboratory')) &&
            obs.valueQuantity?.value != null
          ) {
            const range = obs.referenceRange?.[0];
            const low = range?.low?.value;
            const high = range?.high?.value;
            const v = obs.valueQuantity.value;
            labRows.push({
              name: obs.code?.text ?? coding?.display ?? coding?.code ?? 'Lab',
              date: when,
              value: `${v} ${obs.valueQuantity.unit ?? ''}`.trim(),
              range: low != null && high != null ? `${low}–${high} ${range?.low?.unit ?? ''}`.trim() : '—',
              flagged: low != null && high != null ? v < low || v > high : false,
            });
          }
        }

        setWeight(weightPts);
        setMood(moodPts);
        setEnergy(energyPts);
        setSleep(sleepPts.slice(-14));
        setSymptoms(symptomObs.reverse().slice(0, 8));
        setLabs(labRows.reverse().slice(0, 12));
        setCheckin(responses[0]);

        // One-line summary card — plain client-side facts, no AI.
        const stats = adherenceStats(meds, admins, summarizeDays(meds, admins, 30));
        const latestWeight = weightPts[weightPts.length - 1];
        const firstWeight = weightPts[0];
        const delta =
          latestWeight && firstWeight
            ? (latestWeight.value - firstWeight.value).toFixed(1)
            : undefined;
        const parts: string[] = [];
        if (stats.pct !== null) parts.push(`adherence ${stats.pct}% (30d)`);
        if (stats.streak) parts.push(`${stats.streak}-day streak`);
        if (latestWeight) {
          parts.push(
            `weight ${latestWeight.value} kg${delta !== undefined ? ` (${Number(delta) >= 0 ? '+' : ''}${delta} kg over 90d)` : ''}`
          );
        }
        const lastMood = moodPts[moodPts.length - 1];
        if (lastMood) parts.push(`mood ${lastMood.value}/10`);
        setSummary(parts.length ? parts.join(' · ') : 'No data yet — start logging to see your overview.');
      } catch (err) {
        setError(normalizeErrorString(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [medplum]);

  if (loading) return <Loader />;
  if (error) {
    return (
      <Alert color="red" title="Could not load overview">
        {error}
      </Alert>
    );
  }

  return (
    <Stack>
      <Title order={2}>Health overview</Title>

      <Card withBorder>
        <Text size="sm" c="dimmed" tt="uppercase">
          At a glance
        </Text>
        <Text fw={600}>{summary}</Text>
      </Card>

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <ChartCard title="Weight (kg, 90d)" data={weight} color="#0ca678" domain={['auto', 'auto']} />
        <Card withBorder>
          <Title order={5} mb="xs">
            Mood & energy (1–10, 30d)
          </Title>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={mergeSeries(mood, energy)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" fontSize={11} minTickGap={24} />
              <YAxis domain={[0, 10]} fontSize={11} width={28} />
              <ChartTooltip />
              <Line type="monotone" dataKey="mood" stroke="#7048e8" dot={false} />
              <Line type="monotone" dataKey="energy" stroke="#f08c00" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
        <ChartCard title="Sleep (hours, last 14 nights)" data={sleep} color="#1c7ed6" domain={[0, 12]} />
        <Card withBorder>
          <Title order={5} mb="xs">
            Recent symptoms
          </Title>
          <Stack gap={6}>
            {symptoms.map((s) => (
              <Group key={s.id} gap="xs" wrap="nowrap">
                <Text size="xs" c="dimmed" w={80} style={{ flexShrink: 0 }}>
                  {(s.effectiveDateTime ?? '').slice(0, 10)}
                </Text>
                <Text size="sm">{s.valueString}</Text>
              </Group>
            ))}
            {symptoms.length === 0 && <Text c="dimmed">No symptoms logged in the last 90 days.</Text>}
          </Stack>
        </Card>
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder>
          <Title order={5} mb="xs">
            Recent labs
          </Title>
          {labs.length === 0 ? (
            <Text c="dimmed">No lab results in the last 90 days — upload a report under Documents.</Text>
          ) : (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Analyte</Table.Th>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Value</Table.Th>
                  <Table.Th>Reference</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {labs.map((row, i) => (
                  <Table.Tr key={i}>
                    <Table.Td>{row.name}</Table.Td>
                    <Table.Td>{row.date}</Table.Td>
                    <Table.Td c={row.flagged ? 'red' : undefined} fw={row.flagged ? 700 : undefined}>
                      {row.value}
                    </Table.Td>
                    <Table.Td c="dimmed">{row.range}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>
        <Card withBorder>
          <Title order={5} mb="xs">
            Latest check-in
          </Title>
          {checkin ? (
            <Stack gap={6}>
              <Text size="xs" c="dimmed">
                {(checkin.authored ?? '').replace('T', ' ').slice(0, 16)}
              </Text>
              {checkin.item?.map((item) => {
                const a = item.answer?.[0];
                const value = a?.valueInteger ?? a?.valueDecimal ?? a?.valueString ?? a?.valueBoolean;
                return value !== undefined && value !== '' ? (
                  <Group key={item.linkId} gap="xs">
                    <Text size="sm" c="dimmed" w={110}>
                      {item.linkId}
                    </Text>
                    <Text size="sm">{String(value)}</Text>
                  </Group>
                ) : null;
              })}
            </Stack>
          ) : (
            <Text c="dimmed">No check-in yet — do your first one under Daily check-in.</Text>
          )}
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

function mergeSeries(mood: Point[], energy: Point[]) {
  const byDate = new Map<string, { date: string; mood?: number; energy?: number }>();
  for (const p of mood) byDate.set(p.date, { ...(byDate.get(p.date) ?? { date: p.date }), mood: p.value });
  for (const p of energy) byDate.set(p.date, { ...(byDate.get(p.date) ?? { date: p.date }), energy: p.value });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function ChartCard(props: { title: string; data: Point[]; color: string; domain: [number | string, number | string] }) {
  return (
    <Card withBorder>
      <Title order={5} mb="xs">
        {props.title}
      </Title>
      {props.data.length === 0 ? (
        <Text c="dimmed">No data yet.</Text>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={props.data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" fontSize={11} minTickGap={24} />
            <YAxis domain={props.domain as [number, number]} fontSize={11} width={34} />
            <ChartTooltip />
            <Line type="monotone" dataKey="value" stroke={props.color} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
