import { Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import type { DaySummary, DayStatus } from '../fhir';

const COLORS: Record<DayStatus, string> = {
  'all-taken': 'var(--mantine-color-teal-6)',
  partial: 'var(--mantine-color-yellow-5)',
  'none-taken': 'var(--mantine-color-red-5)',
  unlogged: 'var(--mantine-color-gray-3)',
  'no-doses': 'var(--mantine-color-gray-1)',
};

const LABELS: Record<DayStatus, string> = {
  'all-taken': 'all doses taken',
  partial: 'partially taken',
  'none-taken': 'skipped/missed',
  unlogged: 'not logged',
  'no-doses': 'no scheduled doses',
};

/** Calendar heatmap of dose days, GitHub-style: columns = weeks, rows = weekdays. */
export function Heatmap({ days }: { days: DaySummary[] }) {
  if (days.length === 0) {
    return null;
  }
  // Pad the start so the first column begins on Monday
  const firstWeekday = (new Date(`${days[0].date}T12:00`).getDay() + 6) % 7;
  const cells: (DaySummary | null)[] = [...Array(firstWeekday).fill(null), ...days];
  const weeks: (DaySummary | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  return (
    <Stack gap="xs">
      <Group gap={3} align="flex-start" wrap="nowrap" style={{ overflowX: 'auto' }}>
        {weeks.map((week, wi) => (
          <Stack key={wi} gap={3}>
            {week.map((day, di) =>
              day ? (
                <Tooltip
                  key={day.date}
                  label={`${day.date}: ${day.taken}/${day.scheduled} taken — ${LABELS[day.status]}`}
                  withArrow
                >
                  <Box
                    w={14}
                    h={14}
                    style={{ borderRadius: 3, background: COLORS[day.status], cursor: 'default' }}
                  />
                </Tooltip>
              ) : (
                <Box key={`pad-${di}`} w={14} h={14} />
              )
            )}
          </Stack>
        ))}
      </Group>
      <Group gap="sm">
        {(Object.keys(LABELS) as DayStatus[]).map((status) => (
          <Group key={status} gap={4}>
            <Box w={10} h={10} style={{ borderRadius: 2, background: COLORS[status] }} />
            <Text size="xs" c="dimmed">
              {LABELS[status]}
            </Text>
          </Group>
        ))}
      </Group>
    </Stack>
  );
}
