import { Tooltip } from '@mantine/core';
import type { DaySummary, DayStatus } from '../fhir';
import { T, mono } from '../tokens';

/** Design-handoff adherence palette (tinted trio for large calendar cells). */
const COLORS: Record<DayStatus, string> = {
  'all-taken': T.heatTaken, // #ddf2e8
  partial: T.heatLate, // #fbf3e4
  'none-taken': T.heatMissed, // #f8dede
  unlogged: T.hairline, // #e8e8e5 — scheduled but nothing logged
  'no-doses': T.band, // #f4f4f2 — nothing scheduled
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-start', overflowX: 'auto' }}>
        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {week.map((day, di) =>
              day ? (
                <Tooltip
                  key={day.date}
                  label={`${day.date}: ${day.taken}/${day.scheduled} taken — ${LABELS[day.status]}`}
                  withArrow
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      background: COLORS[day.status],
                      cursor: 'default',
                    }}
                  />
                </Tooltip>
              ) : (
                <div key={`pad-${di}`} style={{ width: 14, height: 14 }} />
              )
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {(Object.keys(LABELS) as DayStatus[]).map((status) => (
          <span key={status} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{ width: 10, height: 10, borderRadius: 2, background: COLORS[status] }}
            />
            <span style={mono(10, 400, T.tertiary)}>{LABELS[status]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
