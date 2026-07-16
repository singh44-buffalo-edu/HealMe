import { Loader, Menu } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { MedicationAdministration, Task } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Heatmap } from '../components/Heatmap';
import {
  CardTitle,
  Chip,
  DsCard,
  Heatstrip,
  PageHeader,
  PillButton,
  StatusDot,
} from '../components/ds';
import type { CheckinDef, DoseAction, DoseSlot, MedInfo } from '../fhir';
import {
  CADENCE_LABEL,
  OVERDUE_GRACE_MINUTES,
  adherenceStats,
  adminForSlot,
  completeFollowUp,
  getPatient,
  loadAdmins,
  loadCheckins,
  loadFollowUps,
  loadMeds,
  localDateString,
  logDose,
  slotsForDate,
  summarizeDays,
} from '../fhir';
import { T, mono } from '../tokens';

const HEATMAP_DAYS = 91; // 13 weeks
const STATS_DAYS = 30;

/**
 * Heatstrip day with some-taken/none-missed but not fully logged — the same
 * partial tint the 13-week Heatmap uses, so partial never reads as missed.
 */
const STRIP_PARTIAL = T.heatLate;

const PAGE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 20 };

// ---------------------------------------------------------------------------
// Local presentation helpers (design-handoff "Medications" screen language)
// ---------------------------------------------------------------------------

/** Static dot + mono uppercase label pair for derived states (design StatusLabel). */
function StatusTag({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <StatusDot color={color} size={7} />
      <span style={{ ...mono(10, 500, color), textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </span>
  );
}

/** Life-critical flag — owner-set, always prominent next to the med name. */
function CriticalChip() {
  return (
    <span
      style={{
        ...mono(9, 500, T.outOfRange),
        letterSpacing: '.08em',
        background: T.destructiveTint,
        borderRadius: 20,
        padding: '2px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      CRITICAL
    </span>
  );
}

/** react-router Link styled as a design-system pill button. */
function PillLink({
  to,
  variant = 'primary',
  children,
}: {
  to: string;
  variant?: 'primary' | 'secondary';
  children: ReactNode;
}) {
  const styles: Record<'primary' | 'secondary', CSSProperties> = {
    primary: { background: T.green, color: '#fff', fontWeight: 600 },
    secondary: { background: T.band, color: T.secondary, fontWeight: 500 },
  };
  return (
    <Link
      to={to}
      style={{
        display: 'inline-block',
        borderRadius: 20,
        padding: '6px 14px',
        fontSize: 12.5,
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        ...styles[variant],
      }}
    >
      {children}
    </Link>
  );
}

/** Card header row: title 14.5/600 + right-aligned mono meta. */
function CardHeader({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 22px 10px' }}>
      <CardTitle size={14.5}>{title}</CardTitle>
      {meta ? <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>{meta}</span> : null}
    </div>
  );
}

/** Full-bleed row in a flush card — hairline top divider on every row (incl. first). */
function Row({
  columns,
  children,
  padding = '12px 22px',
}: {
  columns: string;
  children: ReactNode;
  padding?: string;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: columns,
        gap: 18,
        alignItems: 'center',
        padding,
        borderTop: `1px solid ${T.band}`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Attention card — standard white card. Status color lives only in the 10px dot
 * and the critical value fragments of detail lines; it never floods the background.
 * Prominence comes from position at the top of the page, not from tint.
 */
function AlertCard({
  tone,
  title,
  children,
}: {
  tone: 'critical' | 'watch';
  title: string;
  children: ReactNode;
}) {
  return (
    <DsCard padding="16px 22px" gap={8}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <StatusDot color={tone === 'critical' ? T.outOfRange : T.watch} size={10} />
        <span style={{ fontSize: 14, fontWeight: 500, letterSpacing: '-.01em', color: T.ink }}>
          {title}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 20 }}>
        {children}
      </div>
    </DsCard>
  );
}

/** `2026-01-15` → `Jan 2026` for the med detail line. */
function monthYear(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AdherencePage() {
  const medplum = useMedplum();
  const [meds, setMeds] = useState<MedInfo[]>([]);
  const [admins, setAdmins] = useState<MedicationAdministration[]>([]);
  const [checkins, setCheckins] = useState<CheckinDef[]>([]);
  const [followUps, setFollowUps] = useState<Task[]>([]);
  const [patientId, setPatientId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => new Date());

  // The overdue/critical logic depends on wall-clock time — keep it live so
  // an idle tab still raises the critical-medication alert.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [patient, medList, adminList, checkinList, followUpList] = await Promise.all([
        getPatient(medplum),
        loadMeds(medplum),
        loadAdmins(medplum, HEATMAP_DAYS),
        loadCheckins(medplum),
        loadFollowUps(medplum),
      ]);
      setPatientId(patient?.id);
      setMeds(medList);
      setAdmins(adminList);
      setCheckins(checkinList);
      setFollowUps(followUpList);
      setError(undefined);
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setLoading(false);
    }
  }, [medplum]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (loading) {
    return (
      <div style={PAGE}>
        <PageHeader title="Medications" subtitle="loading adherence data" />
        <Loader size="sm" color={T.green} />
      </div>
    );
  }
  if (error) {
    return (
      <div style={PAGE}>
        <PageHeader title="Medications" />
        <AlertCard tone="critical" title="Could not load adherence data">
          <span style={{ fontSize: 13, color: T.secondary }}>{error}</span>
        </AlertCard>
      </div>
    );
  }
  if (!patientId) {
    return (
      <div style={PAGE}>
        <PageHeader title="Medications" />
        <AlertCard tone="watch" title="No patient record">
          <span style={{ fontSize: 13, color: T.secondary }}>
            Run <code style={mono(12, 500, T.ink)}>make seed</code> to create the patient and sample
            data.
          </span>
        </AlertCard>
      </div>
    );
  }

  const days = summarizeDays(meds, admins, HEATMAP_DAYS);
  // Stats over the last 30 summarized days; streak over the full heatmap window.
  const stats = adherenceStats(meds, admins, days.slice(-STATS_DAYS), days);

  const today = localDateString(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1); // local calendar math — DST safe
  const yesterday = localDateString(yesterdayDate);

  // Split into label + status fragments so only the critical fragment is
  // colored in the alert card; the concatenated text stays byte-identical.
  const criticalProblems: { label: string; status: string }[] = [];
  for (const slot of slotsForDate(meds, today)) {
    if (!slot.med.lifeCritical) continue;
    const admin = adminForSlot(admins, slot);
    const overdue =
      !admin && now.getTime() - slot.scheduled.getTime() > OVERDUE_GRACE_MINUTES * 60_000;
    const label = `${slot.med.name} ${slot.time.slice(0, 5)}`;
    if (overdue) criticalProblems.push({ label, status: 'is overdue' });
    if (admin?.status === 'not-done') {
      criticalProblems.push({ label, status: 'was not taken' });
    }
  }

  const lowStock = [
    ...new Map(
      meds
        .map((m) => m.cartridge)
        .filter((c): c is NonNullable<typeof c> => Boolean(c?.low))
        .map((c) => [c.device.id, c])
    ).values(),
  ];

  // Per-med derived display state (design: MISSED TODAY outranks the 30D percentage).
  const missedTodayFor = (med: MedInfo): boolean =>
    slotsForDate([med], today).some((slot) => {
      const admin = adminForSlot(admins, slot);
      if (admin?.status === 'not-done') return true;
      return !admin && now.getTime() - slot.scheduled.getTime() > OVERDUE_GRACE_MINUTES * 60_000;
    });

  // 30-day per-med heatstrip: taken / missed / partial / no data (oldest→newest).
  const stripDaysFor = (med: MedInfo): string[] =>
    days.slice(-STATS_DAYS).map((day) => {
      const slots = slotsForDate([med], day.date);
      if (slots.length === 0) return T.hairline;
      let taken = 0;
      let notDone = 0;
      for (const slot of slots) {
        const admin = adminForSlot(admins, slot);
        if (admin?.status === 'completed') taken++;
        else if (admin?.status === 'not-done') notDone++;
      }
      if (notDone > 0) return T.outOfRange;
      if (taken === slots.length) return T.inRange;
      if (taken > 0) return STRIP_PARTIAL;
      return T.hairline;
    });

  const logged = stats.taken + stats.notDone;
  const subtitle = [
    `${meds.length} active`,
    `${stats.pct === null ? '—' : `${stats.pct}%`} adherence 30D of logged`,
    `${stats.streak}-day all-taken streak`,
    `${logged} doses logged 30D`,
  ].join(' · ');

  const hasDayPanels =
    slotsForDate(meds, today).length > 0 || slotsForDate(meds, yesterday).length > 0;

  return (
    <div style={PAGE}>
      <PageHeader title="Medications" subtitle={subtitle} />

      {criticalProblems.length > 0 && (
        <AlertCard tone="critical" title="Critical medication — attention needed">
          {criticalProblems.map((p) => (
            <span key={`${p.label} ${p.status}`} style={{ fontSize: 13, letterSpacing: '-.01em' }}>
              {p.label}{' '}
              <span style={mono(11, 500, T.outOfRange)}>{p.status}</span>
            </span>
          ))}
        </AlertCard>
      )}

      {lowStock.length > 0 && (
        <AlertCard tone="watch" title="Cartridge low on stock">
          {lowStock.map((c) => (
            <span key={c.device.id} style={{ fontSize: 13, letterSpacing: '-.01em' }}>
              {c.name}:{' '}
              <span style={mono(11, 500, T.watch)}>
                {c.remaining} of {c.capacity} doses left
              </span>{' '}
              <span style={mono(11, 400, T.secondary)}>(threshold {c.lowThreshold})</span>
            </span>
          ))}
        </AlertCard>
      )}

      <TodayDuePanel checkins={checkins} followUps={followUps} onChanged={reload} />

      {hasDayPanels && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <DayPanel
            title="Today"
            date={today}
            meds={meds}
            admins={admins}
            patientId={patientId}
            onChanged={reload}
            now={now}
          />
          <DayPanel
            title="Yesterday"
            date={yesterday}
            meds={meds}
            admins={admins}
            patientId={patientId}
            onChanged={reload}
            now={now}
          />
        </div>
      )}

      <DsCard flush gap={0}>
        <CardHeader title="Active medications" meta={`adherence ${STATS_DAYS}D · of logged doses`} />
        {stats.perMed.map(({ med, taken, notDone, pct }) => {
          const missedToday = missedTodayFor(med);
          // Documented 30-day adherence thresholds: >=90 in-range, >=70 watch,
          // <70 out-of-range; null (no logs) is neutral — never a green claim.
          const pctColor =
            pct === null
              ? T.quaternary
              : pct >= 90
                ? T.inRange
                : pct >= 70
                  ? T.watch
                  : T.outOfRange;
          // Tag encodes both signals: a missed/overdue dose today outranks the
          // 30D percentage; otherwise the tag follows the thresholds above.
          const tag = missedToday
            ? { color: T.outOfRange, label: 'MISSED TODAY' }
            : {
                color: pctColor,
                label:
                  pct === null
                    ? 'NO LOGS 30D'
                    : pct >= 90
                      ? 'ON TRACK'
                      : pct >= 70
                        ? 'WATCH 30D'
                        : 'LOW 30D',
              };
          const detail = [
            med.instructions,
            med.cartridge ? med.cartridge.name : 'manual',
            `since ${monthYear(med.startDate)}`,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <Row key={med.request.id} columns="1.3fr auto auto" padding="15px 22px">
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-.01em' }}>
                    {med.name}
                  </span>
                  {med.lifeCritical && <CriticalChip />}
                </span>
                <span style={mono(10.5, 400, T.tertiary)}>{detail}</span>
              </span>
              <span style={{ width: 238 }}>
                <Heatstrip
                  days={stripDaysFor(med)}
                  header={`adherence ${STATS_DAYS}D`}
                  headerRight={
                    <span style={{ color: pctColor }}>{pct === null ? 'no logs' : `${pct}%`}</span>
                  }
                />
              </span>
              <span
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}
              >
                <StatusTag color={tag.color} label={tag.label} />
                <span style={mono(9.5, 400, T.quaternary)}>
                  {pct === null ? 'no logs' : `${taken} taken / ${notDone} not taken`}
                </span>
              </span>
            </Row>
          );
        })}
        {stats.perMed.length === 0 && (
          <div style={{ padding: '16px 22px', borderTop: `1px solid ${T.band}` }}>
            <span style={mono(11, 400, T.quaternary)}>
              No active medications — add one in the Medplum app.
            </span>
          </div>
        )}
      </DsCard>

      <DsCard padding="18px 22px" gap={12}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <CardTitle size={14.5}>Last 13 weeks</CardTitle>
          <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>
            {HEATMAP_DAYS} days · all meds
          </span>
        </div>
        <Heatmap days={days} />
      </DsCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Due panel
// ---------------------------------------------------------------------------

function TodayDuePanel({
  checkins,
  followUps,
  onChanged,
}: {
  checkins: CheckinDef[];
  followUps: Task[];
  onChanged: () => void;
}) {
  const medplum = useMedplum();
  const due = checkins.filter((d) => !d.existing);
  if (due.length === 0 && followUps.length === 0) {
    return null;
  }

  const resolve = async (task: Task) => {
    try {
      await completeFollowUp(medplum, task);
      notifications.show({ color: 'teal', message: 'Follow-up resolved' });
      onChanged();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not resolve', message: normalizeErrorString(err) });
    }
  };

  return (
    <DsCard flush gap={0}>
      <CardHeader title="Due now" meta={`${due.length + followUps.length} due`} />
      {due.map((def) => (
        <Row key={def.questionnaire.url} columns="1fr auto">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: '-.01em' }}>
              {def.questionnaire.title}
            </span>
            <Chip>{CADENCE_LABEL[def.cadence]}</Chip>
          </span>
          <PillLink to="/checkin">Check in</PillLink>
        </Row>
      ))}
      {followUps.map((task) => (
        <Row key={task.id} columns="1fr auto">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <Chip>follow-up</Chip>
            <span style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: '-.01em' }}>
              {task.description}
            </span>
            {task.executionPeriod?.end && (
              <span style={mono(10, 400, T.quaternary)}>
                due {task.executionPeriod.end.slice(0, 10)}
              </span>
            )}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <PillLink to="/log" variant="secondary">
              Log update
            </PillLink>
            <PillButton
              size={12.5}
              onClick={() => resolve(task)}
              style={{ background: T.greenTint, color: T.green, padding: '6px 14px' }}
            >
              Resolved
            </PillButton>
          </span>
        </Row>
      ))}
    </DsCard>
  );
}

// ---------------------------------------------------------------------------
// Day panel (Today / Yesterday) — the only place doses are logged
// ---------------------------------------------------------------------------

function DayPanel(props: {
  title: string;
  date: string;
  meds: MedInfo[];
  admins: MedicationAdministration[];
  patientId: string;
  onChanged: () => void;
  now: Date;
}) {
  const medplum = useMedplum();
  const [busy, setBusy] = useState<string>();
  const slots = slotsForDate(props.meds, props.date);

  const act = async (slot: DoseSlot, action: DoseAction) => {
    setBusy(slot.identValue);
    try {
      // Backdated slots record the scheduled time, not the moment of the tap —
      // marking yesterday's dose taken must not stamp today's clock time.
      const isToday = slot.date === localDateString(props.now);
      await logDose(medplum, props.patientId, slot, action, isToday ? undefined : slot.scheduled);
      notifications.show({
        color: action === 'taken' ? 'teal' : 'yellow',
        message: `${slot.med.name} ${slot.time.slice(0, 5)} marked ${action}`,
      });
      props.onChanged();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not log dose', message: normalizeErrorString(err) });
    } finally {
      setBusy(undefined);
    }
  };

  if (slots.length === 0) {
    return null;
  }

  const takenCount = slots.filter(
    (slot) => adminForSlot(props.admins, slot)?.status === 'completed'
  ).length;

  return (
    <DsCard flush gap={0}>
      <CardHeader
        title={props.title}
        meta={`${takenCount}/${slots.length} taken · ${props.date}`}
      />
      {slots.map((slot) => {
        const admin = adminForSlot(props.admins, slot);
        const isFuture = slot.scheduled.getTime() > props.now.getTime();
        const overdue =
          !admin &&
          !isFuture &&
          props.now.getTime() - slot.scheduled.getTime() > OVERDUE_GRACE_MINUTES * 60_000;
        const saving = busy === slot.identValue;
        return (
          <Row key={slot.identValue} columns="46px 1fr auto">
            <span style={mono(12.5, 500, T.ink)}>{slot.time.slice(0, 5)}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: '-.01em' }}>
                {slot.med.name}
              </span>
              {slot.med.lifeCritical && <CriticalChip />}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {admin?.status === 'completed' && <StatusTag color={T.inRange} label="taken" />}
              {admin?.status === 'not-done' &&
                (admin.statusReason?.[0]?.coding?.[0]?.code === 'user-marked-missed' ? (
                  <StatusTag color={T.outOfRange} label="missed" />
                ) : (
                  <StatusTag color={T.watch} label="skipped" />
                ))}
              {!admin && isFuture && <StatusTag color={T.quaternary} label="upcoming" />}
              {overdue && <StatusTag color={T.watch} label="overdue" />}
              {!admin && !isFuture && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <PillButton
                    variant="primary"
                    size={12.5}
                    disabled={saving}
                    onClick={() => act(slot, 'taken')}
                    style={{ padding: '6px 14px' }}
                  >
                    Taken
                  </PillButton>
                  <PillButton
                    variant="secondary"
                    size={12.5}
                    disabled={saving}
                    onClick={() => act(slot, 'skipped')}
                  >
                    Skip
                  </PillButton>
                  <PillButton
                    variant="destructive-tint"
                    size={12.5}
                    disabled={saving}
                    onClick={() => act(slot, 'missed')}
                    style={{ padding: '6px 14px' }}
                  >
                    Missed
                  </PillButton>
                </span>
              )}
              {admin && (
                <Menu position="bottom-end">
                  <Menu.Target>
                    <button
                      type="button"
                      disabled={saving}
                      style={{
                        border: 'none',
                        cursor: saving ? 'not-allowed' : 'pointer',
                        background: 'transparent',
                        fontFamily: 'inherit',
                        fontSize: 12,
                        fontWeight: 500,
                        color: T.tertiary,
                        padding: '4px 10px',
                        borderRadius: 16,
                      }}
                    >
                      change
                    </button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => act(slot, 'taken')}>Mark taken</Menu.Item>
                    <Menu.Item onClick={() => act(slot, 'skipped')}>Mark skipped</Menu.Item>
                    <Menu.Item onClick={() => act(slot, 'missed')}>Mark missed</Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              )}
            </span>
          </Row>
        );
      })}
    </DsCard>
  );
}
