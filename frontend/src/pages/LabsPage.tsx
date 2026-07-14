import { Alert, Badge, Card, Group, Loader, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface Analyte {
  name: string;
  unit: string;
  low?: number;
  high?: number;
  points: { date: string; value: number }[];
  latest: { date: string; value: number };
  outOfRange: boolean;
}

export function LabsPage() {
  const medplum = useMedplum();
  const [analytes, setAnalytes] = useState<Analyte[]>();
  const [error, setError] = useState<string>();

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
      <Alert color="red" title="Could not load labs">
        {error}
      </Alert>
    );
  }
  if (!analytes) return <Loader />;

  return (
    <Stack>
      <Title order={2}>Labs</Title>
      <Text c="dimmed" size="sm">
        Per-analyte trends against the reference range stated on each report. Upload lab reports under
        Documents to add more history.
      </Text>
      {analytes.length === 0 && (
        <Text c="dimmed">No lab results yet — approve extracted lab values from an uploaded report.</Text>
      )}
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {analytes.map((analyte) => (
          <AnalyteCard key={analyte.name} analyte={analyte} />
        ))}
      </SimpleGrid>
    </Stack>
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

function AnalyteCard({ analyte }: { analyte: Analyte }) {
  const pad =
    analyte.low != null && analyte.high != null ? (analyte.high - analyte.low) * 0.4 : undefined;
  const domain: [number | string, number | string] =
    analyte.low != null && analyte.high != null && pad != null
      ? [
          Math.min(analyte.low - pad, Math.min(...analyte.points.map((p) => p.value))),
          Math.max(analyte.high + pad, Math.max(...analyte.points.map((p) => p.value))),
        ]
      : ['auto', 'auto'];

  return (
    <Card withBorder>
      <Group justify="space-between" mb="xs">
        <Title order={5}>{analyte.name}</Title>
        <Group gap="xs">
          <Badge color={analyte.outOfRange ? 'red' : 'teal'} variant="light">
            latest {analyte.latest.value} {analyte.unit}
          </Badge>
          {analyte.low != null && analyte.high != null && (
            <Text size="xs" c="dimmed">
              ref {analyte.low}–{analyte.high} {analyte.unit}
            </Text>
          )}
        </Group>
      </Group>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={analyte.points}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" fontSize={11} minTickGap={28} />
          <YAxis domain={domain as [number, number]} fontSize={11} width={40} />
          <ChartTooltip />
          {analyte.low != null && analyte.high != null && (
            <ReferenceArea y1={analyte.low} y2={analyte.high} fill="#0ca678" fillOpacity={0.08} />
          )}
          <Line type="monotone" dataKey="value" stroke="#1c7ed6" dot />
        </LineChart>
      </ResponsiveContainer>
      <Table mt="xs">
        <Table.Tbody>
          {[...analyte.points].reverse().slice(0, 5).map((p) => (
            <Table.Tr key={p.date + p.value}>
              <Table.Td>{p.date}</Table.Td>
              <Table.Td>
                {p.value} {analyte.unit}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}
