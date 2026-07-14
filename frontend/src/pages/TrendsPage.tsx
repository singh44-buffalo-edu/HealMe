import { Alert, Card, Loader, SegmentedControl, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
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
import { CS_OBS, LOINC } from '../fhir';

interface Point {
  date: string;
  value: number;
}

interface Series {
  weight: Point[];
  sleep: Point[];
  mood: Point[];
  energy: Point[];
}

export function TrendsPage() {
  const medplum = useMedplum();
  const [windowDays, setWindowDays] = useState('90');
  const [series, setSeries] = useState<Series>();
  const [error, setError] = useState<string>();

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
          const date = (obs.effectiveDateTime ?? obs.effectivePeriod?.end ?? '').slice(0, 10);
          if (!date) continue;
          if (coding?.system === LOINC && coding.code === '29463-7' && obs.valueQuantity?.value != null) {
            next.weight.push({ date, value: obs.valueQuantity.value });
          } else if (coding?.system === CS_OBS && coding.code === 'sleep-duration' && obs.valueQuantity?.value != null) {
            next.sleep.push({ date, value: obs.valueQuantity.value });
          } else if (coding?.system === CS_OBS && coding.code === 'mood' && obs.valueInteger != null) {
            next.mood.push({ date, value: obs.valueInteger });
          } else if (coding?.system === CS_OBS && coding.code === 'energy' && obs.valueInteger != null) {
            next.energy.push({ date, value: obs.valueInteger });
          }
        }
        if (!cancelled) setSeries(next);
      } catch (err) {
        if (!cancelled) setError(normalizeErrorString(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [medplum, windowDays]);

  if (error) {
    return (
      <Alert color="red" title="Could not load trends">
        {error}
      </Alert>
    );
  }

  return (
    <Stack>
      <Title order={2}>Trends</Title>
      <SegmentedControl
        value={windowDays}
        onChange={setWindowDays}
        data={[
          { label: '30 days', value: '30' },
          { label: '90 days', value: '90' },
          { label: '1 year', value: '365' },
        ]}
        w={280}
      />
      {!series ? (
        <Loader />
      ) : (
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <TrendCard title="Weight (kg)" data={series.weight} color="#0ca678" domain={['auto', 'auto']} />
          <TrendCard title="Sleep (hours)" data={series.sleep} color="#1c7ed6" domain={[0, 12]} />
          <TrendCard title="Mood (1–10)" data={series.mood} color="#7048e8" domain={[0, 10]} />
          <TrendCard title="Energy (1–10)" data={series.energy} color="#f08c00" domain={[0, 10]} />
        </SimpleGrid>
      )}
    </Stack>
  );
}

function TrendCard(props: {
  title: string;
  data: Point[];
  color: string;
  domain: [number | string, number | string];
}) {
  return (
    <Card withBorder>
      <Title order={5} mb="xs">
        {props.title}
      </Title>
      {props.data.length === 0 ? (
        <Text c="dimmed">No data in this window.</Text>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={props.data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" fontSize={11} minTickGap={28} />
            <YAxis domain={props.domain as [number, number]} fontSize={11} width={34} />
            <ChartTooltip />
            <Line type="monotone" dataKey="value" stroke={props.color} dot={props.data.length < 40} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
