import { Alert, Loader } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconPill, IconPillOff, IconStethoscope } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { DsCard, Eyebrow, FilterChips, PageHeader } from '../components/ds';
import type { MedInfo } from '../fhir';
import { CS_OBS, loadAdmins, loadMeds, localDateString } from '../fhir';
import { T, mono } from '../tokens';

const WINDOW_DAYS = 90;

type EventKind = 'symptom' | 'missed' | 'med-start';

interface TimelineEvent {
  date: string; // YYYY-MM-DD
  kind: EventKind;
  label: string;
  /** Full source timestamp — presentation only (drives the time cell + in-day ordering). */
  when?: string;
  /** Event belongs to a life-critical medication. */
  critical?: boolean;
}

interface Lane {
  name: string;
  critical?: boolean;
  events: TimelineEvent[];
}

/** Spine / rule hairline from the design handoff (Web - Timeline). */
const SPINE = '#e4e4e1';

/** Lane-label column width (lanes card) — fixed so every lane's day cells align. */
const LANE_LABEL_W = 180;

const KIND_META: Record<
  EventKind,
  { dot: string; legend: string; Icon: typeof IconPill }
> = {
  // Symptoms are measured data → T.inRange; the glyph (stethoscope) carries the
  // meaning. Never T.metric.weight — that hue means weight/body elsewhere.
  symptom: { dot: T.inRange, legend: 'symptom', Icon: IconStethoscope },
  missed: { dot: T.outOfRange, legend: 'dose skipped/missed', Icon: IconPillOff },
  // Established 'med change' encoding on this page — no BP data is plotted here,
  // so the hue is unambiguous.
  'med-start': { dot: T.metric.bp, legend: 'medication started/changed', Icon: IconPill },
};

const FILTERS: { value: 'all' | EventKind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'symptom', label: 'Symptoms' },
  { value: 'missed', label: 'Missed doses' },
  { value: 'med-start', label: 'Med changes' },
];

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** 'Wed Jul 15' from a local YYYY-MM-DD (noon anchor avoids TZ day-shift). */
function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return `${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}`;
}

/** 'Jul 10' from YYYY-MM-DD. */
function shortDate(date: string): string {
  return `${MO[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}

/** Local wall-clock HH:MM from a full timestamp; '' when the source has no time part. */
function clockTime(when?: string): string {
  if (!when || when.length <= 10) {
    return '';
  }
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Symptom & side-effect timeline vs medication changes: one lane per active
 * medication (start marker + not-taken doses) and a symptoms lane on a shared
 * 90-day axis, followed by a day-grouped event spine of the same events.
 * Correlation reading is left to the human — display only.
 */
export function TimelinePage() {
  const medplum = useMedplum();
  const [lanes, setLanes] = useState<Lane[]>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<'all' | EventKind>('all');

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
          const startedRaw = med.request.authoredOn ?? med.request.meta?.lastUpdated ?? '';
          const started = startedRaw.slice(0, 10);
          if (started >= sinceStr) {
            events.push({
              date: started,
              kind: 'med-start',
              label: `${med.name} started/updated`,
              when: startedRaw,
              critical: med.lifeCritical,
            });
          }
          for (const admin of admins) {
            if (
              admin.request?.reference === `MedicationRequest/${med.request.id}` &&
              admin.status === 'not-done'
            ) {
              const date = (admin.effectiveDateTime ?? '').slice(0, 10);
              const reason = admin.statusReason?.[0]?.coding?.[0]?.code === 'user-marked-missed' ? 'missed' : 'skipped';
              if (date) {
                events.push({
                  date,
                  kind: 'missed',
                  label: `${med.name} ${reason}`,
                  when: admin.effectiveDateTime,
                  critical: med.lifeCritical,
                });
              }
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
              when: o.effectiveDateTime,
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
  if (!lanes) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
        <Loader size="sm" />
      </div>
    );
  }

  // Day columns, oldest → newest (drives the density scrubber)
  const days: string[] = [];
  const today = new Date();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push(localDateString(d));
  }

  const events = lanes.flatMap((lane) => lane.events);
  const shown = filter === 'all' ? events : events.filter((e) => e.kind === filter);

  // Record density per day (all events, independent of the active filter)
  const countByDay = new Map<string, number>();
  for (const e of events) {
    countByDay.set(e.date, (countByDay.get(e.date) ?? 0) + 1);
  }
  const maxCount = Math.max(1, ...days.map((d) => countByDay.get(d) ?? 0));

  // Day-grouped spine: Today · Yesterday · Earlier this month · older months
  const todayStr = localDateString(today);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yStr = localDateString(yesterday);

  const sorted = [...shown].sort((a, b) => {
    const ka = a.when ?? a.date;
    const kb = b.when ?? b.date;
    return ka > kb ? -1 : ka < kb ? 1 : 0;
  });

  const groups = new Map<string, { label: string; dated: boolean; events: TimelineEvent[] }>();
  for (const e of sorted) {
    let key: string;
    let label: string;
    let dated = false; // dated groups show 'Jul 10' in the time cell instead of a clock time
    if (e.date === todayStr) {
      key = 'today';
      label = `Today · ${dayLabel(e.date)}`;
    } else if (e.date === yStr) {
      key = 'yesterday';
      label = `Yesterday · ${dayLabel(e.date)}`;
    } else if (e.date.slice(0, 7) === todayStr.slice(0, 7)) {
      key = 'this-month';
      label = 'Earlier this month';
      dated = true;
    } else {
      key = e.date.slice(0, 7);
      label = `${MONTHS[Number(e.date.slice(5, 7)) - 1]} ${e.date.slice(0, 4)}`;
      dated = true;
    }
    const g = groups.get(key) ?? { label, dated, events: [] };
    g.events.push(e);
    groups.set(key, g);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Timeline"
        subtitle={`symptoms vs medication changes · last ${WINDOW_DAYS} days`}
        right={<FilterChips options={FILTERS} value={filter} onChange={setFilter} />}
      />

      <DsCard
        padding="14px 22px"
        gap={0}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 16 }}
      >
        <span style={mono(10, 500, T.quaternary)}>{shortDate(days[0]).toUpperCase()}</span>
        <div style={{ flex: 1, height: 26, display: 'flex', alignItems: 'flex-end', gap: 2 }}>
          {days.map((d) => {
            const c = countByDay.get(d) ?? 0;
            return (
              <span
                key={d}
                style={{
                  flex: 1,
                  borderRadius: 1,
                  height: c === 0 ? 2 : 4 + Math.round((c / maxCount) * 14),
                  // Neutral bars — a slightly darker gray marks days that actually
                  // have events; color never encodes recency or status here.
                  background: c === 0 ? T.disabled : T.quaternary,
                }}
              />
            );
          })}
        </div>
        <span style={mono(10, 500, T.ink)}>{shortDate(days[days.length - 1]).toUpperCase()}</span>
      </DsCard>

      {/* Lanes: one row per active med (even with zero events) + symptoms, on a
          shared day axis so symptom-vs-missed-dose alignment stays visible. */}
      <DsCard padding="18px 22px" gap={14}>
        <Eyebrow>One lane per active med · shared {WINDOW_DAYS}-day axis</Eyebrow>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {lanes.map((lane) => {
              const byDate = new Map<string, TimelineEvent[]>();
              for (const e of lane.events) {
                byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
              }
              return (
                <div key={lane.name} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <span
                    style={{
                      width: LANE_LABEL_W,
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 7,
                      paddingRight: 10,
                      boxSizing: 'border-box',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: lane.critical ? 700 : 500,
                        letterSpacing: '-.01em',
                        color: lane.critical ? T.outOfRange : T.ink,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {lane.name}
                      {lane.critical ? ' ⚠' : ''}
                    </span>
                    {lane.events.length === 0 ? (
                      <span style={{ ...mono(9, 400, T.quaternary), flexShrink: 0 }}>no events</span>
                    ) : null}
                  </span>
                  {days.map((day) => {
                    const dayEvents = byDate.get(day);
                    const kind = dayEvents?.[0]?.kind;
                    return (
                      <span
                        key={day}
                        title={
                          dayEvents
                            ? `${day}: ${dayEvents.map((e) => e.label).join('; ')}`
                            : undefined
                        }
                        style={{
                          width: 7,
                          height: 16,
                          borderRadius: 2,
                          flexShrink: 0,
                          background: kind ? KIND_META[kind].dot : T.chip,
                        }}
                      />
                    );
                  })}
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 2, marginTop: 2 }}>
              <span style={{ width: LANE_LABEL_W, flexShrink: 0 }} />
              {days.map((day, i) => (
                <span
                  key={day}
                  style={{
                    ...mono(9, 400, T.quaternary),
                    width: 7,
                    flexShrink: 0,
                    overflow: 'visible',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {i % 14 === 0 ? shortDate(day).toUpperCase() : ''}
                </span>
              ))}
            </div>
          </div>
        </div>
      </DsCard>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        {(Object.keys(KIND_META) as EventKind[]).map((k) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: '#fff',
                border: `2px solid ${KIND_META[k].dot}`,
                boxSizing: 'border-box',
              }}
            />
            <span style={mono(10.5, 400, T.secondary)}>{KIND_META[k].legend}</span>
          </span>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: T.tertiary }}>
          This view only displays your own records; any correlation is something to discuss with your
          clinician.
        </span>
      </div>

      {sorted.length === 0 ? (
        <DsCard>
          <span style={mono(12, 400, T.quaternary)}>
            {events.length === 0
              ? `No events in the last ${WINDOW_DAYS} days — symptoms you log and medication changes will appear here.`
              : `No events of this kind in the last ${WINDOW_DAYS} days.`}
          </span>
        </DsCard>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {[...groups.entries()].map(([key, g]) => (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 0 10px' }}>
                <span
                  style={{
                    ...mono(11, 500, T.tertiary),
                    letterSpacing: '.1em',
                    textTransform: 'uppercase',
                  }}
                >
                  {g.label}
                </span>
                <span style={{ flex: 1, height: 1, background: SPINE }} />
                <span style={mono(10, 400, T.quaternary)}>
                  {g.events.length} event{g.events.length === 1 ? '' : 's'}
                </span>
              </div>
              {g.events.map((e, i) => {
                const { dot, legend, Icon } = KIND_META[e.kind];
                return (
                  <div
                    key={`${e.date}-${e.kind}-${i}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '64px auto 1fr',
                      gap: 14,
                      alignItems: 'start',
                    }}
                  >
                    <span style={{ ...mono(10.5, 400, T.quaternary), textAlign: 'right', paddingTop: 14 }}>
                      {g.dated ? shortDate(e.date) : clockTime(e.when)}
                    </span>
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        alignSelf: 'stretch',
                      }}
                    >
                      <span style={{ width: 1.5, height: 10, background: SPINE }} />
                      <span
                        style={{
                          width: 11,
                          height: 11,
                          borderRadius: '50%',
                          background: '#ffffff',
                          border: `2.5px solid ${dot}`,
                          boxSizing: 'border-box',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ width: 1.5, flex: 1, background: SPINE }} />
                    </div>
                    <DsCard
                      padding="12px 18px"
                      gap={4}
                      style={{
                        borderRadius: 14,
                        boxShadow: '0 1px 2px rgba(0,0,0,.04), 0 6px 20px rgba(0,0,0,.04)',
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <Icon size={13} stroke={1.7} style={{ color: T.secondary, flexShrink: 0 }} />
                        <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-.01em' }}>
                          {e.label}
                        </span>
                        {e.critical ? (
                          <span
                            style={{
                              ...mono(9, 500, T.outOfRange),
                              letterSpacing: '.06em',
                              background: T.destructiveTint,
                              borderRadius: 20,
                              padding: '2px 7px',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            CRITICAL
                          </span>
                        ) : null}
                      </div>
                      <span style={mono(11, 400, T.tertiary)}>{legend}</span>
                    </DsCard>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
