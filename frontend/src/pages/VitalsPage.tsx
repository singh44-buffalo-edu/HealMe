import { Alert, Card, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { LOINC } from '../fhir';

interface Point {
  date: string;
  value: number;
}

interface BpPoint {
  date: string;
  systolic?: number;
  diastolic?: number;
}

const SIMPLE_VITALS: { code: string; title: string; unit: string; color: string }[] = [
  { code: '8867-4', title: 'Heart rate', unit: '/min', color: '#e8590c' },
  { code: '8310-5', title: 'Body temperature', unit: '°C', color: '#c2255c' },
  { code: '59408-5', title: 'SpO2', unit: '%', color: '#1971c2' },
  { code: '2339-0', title: 'Glucose', unit: 'mg/dL', color: '#5f3dc4' },
];

export function VitalsPage() {
  const medplum = useMedplum();
  const [bp, setBp] = useState<BpPoint[]>();
  const [series, setSeries] = useState<Record<string, Point[]>>({});
  const [error, setError] = useState<string>();

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
        const bpPoints: BpPoint[] = [];
        const next: Record<string, Point[]> = {};
        for (const obs of observations) {
          const when = (obs.effectiveDateTime ?? '').slice(0, 10);
          if (!when) continue;
          const code = obs.code?.coding?.find((c) => c.system === LOINC)?.code;
          if (code === '85354-9') {
            const point: BpPoint = { date: when };
            for (const comp of obs.component ?? []) {
              const compCode = comp.code?.coding?.[0]?.code;
              if (compCode === '8480-6') point.systolic = comp.valueQuantity?.value;
              if (compCode === '8462-4') point.diastolic = comp.valueQuantity?.value;
            }
            if (point.systolic !== undefined || point.diastolic !== undefined) bpPoints.push(point);
          } else if (code && obs.valueQuantity?.value != null) {
            next[code] = [...(next[code] ?? []), { date: when, value: obs.valueQuantity.value }];
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
  if (!bp) return <Loader />;

  return (
    <Stack>
      <Title order={2}>Vitals</Title>
      <Text c="dimmed" size="sm">
        Trends over the last year — log readings under Quick add. Values are shown without clinical
        judgment; thresholds worth flagging are something to set with your clinician.
      </Text>
      <Card withBorder>
        <Title order={5} mb="xs">
          Blood pressure (mmHg)
        </Title>
        {bp.length === 0 ? (
          <Text c="dimmed">No blood pressure readings yet.</Text>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={bp}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" fontSize={11} minTickGap={28} />
              <YAxis domain={[40, 200]} fontSize={11} width={34} />
              <ChartTooltip />
              <Legend />
              <Line type="monotone" dataKey="systolic" stroke="#e03131" dot />
              <Line type="monotone" dataKey="diastolic" stroke="#1971c2" dot />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {SIMPLE_VITALS.map((vital) => (
          <Card withBorder key={vital.code}>
            <Title order={5} mb="xs">
              {vital.title} ({vital.unit})
            </Title>
            {(series[vital.code] ?? []).length === 0 ? (
              <Text c="dimmed">No readings yet.</Text>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={series[vital.code]}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" fontSize={11} minTickGap={28} />
                  <YAxis domain={['auto', 'auto']} fontSize={11} width={40} />
                  <ChartTooltip />
                  <Line type="monotone" dataKey="value" stroke={vital.color} dot />
                </LineChart>
              </ResponsiveContainer>
            )}
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  );
}
