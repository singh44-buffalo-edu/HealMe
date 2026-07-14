import { Alert, Box, Card, Group, Loader, Stack, Text, Title, Tooltip } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { useEffect, useState } from 'react';
import type { MedInfo } from '../fhir';
import { CS_OBS, loadAdmins, loadMeds, localDateString } from '../fhir';

const WINDOW_DAYS = 90;

interface TimelineEvent {
  date: string; // YYYY-MM-DD
  kind: 'symptom' | 'missed' | 'med-start';
  label: string;
}

interface Lane {
  name: string;
  critical?: boolean;
  events: TimelineEvent[];
}

/**
 * Symptom & side-effect timeline vs medication changes: one lane per active
 * medication (start marker + not-taken doses) and a symptoms lane, on a
 * shared 90-day axis. Correlation reading is left to the human — display only.
 */
export function TimelinePage() {
  const medplum = useMedplum();
  const [lanes, setLanes] = useState<Lane[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    (async () => {
      try {
        const since = new Date();
        since.setDate(since.getDate() - WINDOW_DAYS);
        const sinceStr = since.toISOString().slice(0, 10);

        const [meds, admins, symptomObs] = await Promise.all([
          loadMeds(medplum),
          loadAdmins(medplum, WINDOW_DAYS),
          medplum.searchResources('Observation', {
            code: `${CS_OBS}|symptom`,
            date: `ge${sinceStr}`,
            _count: '500',
            _sort: 'date',
          }),
        ]);

        const medLanes: Lane[] = meds.map((med: MedInfo) => {
          const events: TimelineEvent[] = [];
          const started = (med.request.authoredOn ?? med.request.meta?.lastUpdated ?? '').slice(0, 10);
          if (started >= sinceStr) {
            events.push({ date: started, kind: 'med-start', label: `${med.name} started/updated` });
          }
          for (const admin of admins) {
            if (
              admin.request?.reference === `MedicationRequest/${med.request.id}` &&
              admin.status === 'not-done'
            ) {
              const date = (admin.effectiveDateTime ?? '').slice(0, 10);
              const reason = admin.statusReason?.[0]?.coding?.[0]?.code === 'user-marked-missed' ? 'missed' : 'skipped';
              if (date) events.push({ date, kind: 'missed', label: `${med.name} ${reason}` });
            }
          }
          return { name: med.name, critical: med.lifeCritical, events };
        });

        const symptomLane: Lane = {
          name: 'Symptoms',
          events: symptomObs
            .map((o) => ({
              date: (o.effectiveDateTime ?? '').slice(0, 10),
              kind: 'symptom' as const,
              label: o.valueString ?? 'Symptom',
            }))
            .filter((e) => e.date),
        };

        setLanes([symptomLane, ...medLanes]);
      } catch (err) {
        setError(normalizeErrorString(err));
      }
    })();
  }, [medplum]);

  if (error) {
    return (
      <Alert color="red" title="Could not load the timeline">
        {error}
      </Alert>
    );
  }
  if (!lanes) return <Loader />;

  // Day columns, oldest → newest
  const days: string[] = [];
  const today = new Date();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push(localDateString(d));
  }

  const COLORS: Record<TimelineEvent['kind'], string> = {
    symptom: 'var(--mantine-color-grape-6)',
    missed: 'var(--mantine-color-red-6)',
    'med-start': 'var(--mantine-color-blue-6)',
  };

  return (
    <Stack>
      <Title order={2}>Symptoms vs. medication timeline</Title>
      <Text c="dimmed" size="sm">
        Last {WINDOW_DAYS} days. Dots are events — hover for detail. This view only displays your own
        records; any correlation is something to discuss with your clinician.
      </Text>
      <Card withBorder style={{ overflowX: 'auto' }}>
        <Stack gap={6}>
          {lanes.map((lane) => {
            const byDate = new Map<string, TimelineEvent[]>();
            for (const e of lane.events) {
              byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
            }
            return (
              <Group key={lane.name} gap={2} wrap="nowrap">
                <Text
                  size="xs"
                  w={190}
                  style={{ flexShrink: 0 }}
                  fw={lane.critical ? 700 : 500}
                  c={lane.critical ? 'red' : undefined}
                  truncate
                >
                  {lane.name}
                  {lane.critical ? ' ⚠' : ''}
                </Text>
                {days.map((day) => {
                  const events = byDate.get(day);
                  const kind = events?.[0]?.kind;
                  return events ? (
                    <Tooltip
                      key={day}
                      label={`${day}: ${events.map((e) => e.label).join('; ')}`}
                      withArrow
                    >
                      <Box
                        w={7}
                        h={16}
                        style={{ borderRadius: 2, background: COLORS[kind as TimelineEvent['kind']], flexShrink: 0 }}
                      />
                    </Tooltip>
                  ) : (
                    <Box
                      key={day}
                      w={7}
                      h={16}
                      style={{ borderRadius: 2, background: 'var(--mantine-color-gray-1)', flexShrink: 0 }}
                    />
                  );
                })}
              </Group>
            );
          })}
          <Group gap={2} wrap="nowrap" mt={2}>
            <Box w={190} style={{ flexShrink: 0 }} />
            {days.map((day, i) => (
              <Text key={day} size="9px" c="dimmed" w={7} style={{ flexShrink: 0, overflow: 'visible', whiteSpace: 'nowrap' }}>
                {i % 14 === 0 ? day.slice(5) : ''}
              </Text>
            ))}
          </Group>
        </Stack>
      </Card>
      <Group gap="md">
        <LegendDot color="var(--mantine-color-grape-6)" label="symptom" />
        <LegendDot color="var(--mantine-color-red-6)" label="dose skipped/missed" />
        <LegendDot color="var(--mantine-color-blue-6)" label="medication started/changed" />
      </Group>
    </Stack>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <Group gap={4}>
      <Box w={10} h={10} style={{ borderRadius: 2, background: color }} />
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Group>
  );
}
