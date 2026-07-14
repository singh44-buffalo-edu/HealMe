import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Menu,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { MedicationAdministration, Task } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Heatmap } from '../components/Heatmap';
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

const HEATMAP_DAYS = 91; // 13 weeks
const STATS_DAYS = 30;

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
    return <Loader />;
  }
  if (error) {
    return (
      <Alert color="red" title="Could not load adherence data">
        {error}
      </Alert>
    );
  }
  if (!patientId) {
    return (
      <Alert color="yellow" title="No patient record">
        Run <code>make seed</code> to create the patient and sample data.
      </Alert>
    );
  }

  const days = summarizeDays(meds, admins, HEATMAP_DAYS);
  // Stats over the last 30 summarized days; streak over the full heatmap window.
  const stats = adherenceStats(meds, admins, days.slice(-STATS_DAYS), days);

  const today = localDateString(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1); // local calendar math — DST safe
  const yesterday = localDateString(yesterdayDate);

  const criticalProblems: string[] = [];
  for (const slot of slotsForDate(meds, today)) {
    if (!slot.med.lifeCritical) continue;
    const admin = adminForSlot(admins, slot);
    const overdue =
      !admin && now.getTime() - slot.scheduled.getTime() > OVERDUE_GRACE_MINUTES * 60_000;
    if (overdue) criticalProblems.push(`${slot.med.name} ${slot.time.slice(0, 5)} is overdue`);
    if (admin?.status === 'not-done') {
      criticalProblems.push(`${slot.med.name} ${slot.time.slice(0, 5)} was not taken`);
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

  return (
    <Stack>
      <Title order={2}>Medication adherence</Title>

      {criticalProblems.length > 0 && (
        <Alert color="red" title="Critical medication — attention needed">
          {criticalProblems.map((p) => (
            <Text key={p} size="sm">
              {p}
            </Text>
          ))}
        </Alert>
      )}

      {lowStock.length > 0 && (
        <Alert color="orange" title="Cartridge low on stock">
          {lowStock.map((c) => (
            <Text key={c.device.id} size="sm">
              {c.name}: {c.remaining} of {c.capacity} doses left (threshold {c.lowThreshold})
            </Text>
          ))}
        </Alert>
      )}

      <TodayDuePanel checkins={checkins} followUps={followUps} onChanged={reload} />

      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <StatCard
          label={`Adherence (${STATS_DAYS}d, of logged doses)`}
          value={stats.pct === null ? '—' : `${stats.pct}%`}
        />
        <StatCard label="Streak (all doses taken)" value={`${stats.streak} day${stats.streak === 1 ? '' : 's'}`} />
        <StatCard label={`Doses logged (${STATS_DAYS}d)`} value={`${stats.taken + stats.notDone}`} />
      </SimpleGrid>

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

      <Card withBorder>
        <Title order={4} mb="sm">
          Per-medication adherence ({STATS_DAYS}d)
        </Title>
        <Stack gap="xs">
          {stats.perMed.map(({ med, taken, notDone, pct }) => (
            <div key={med.request.id}>
              <Group justify="space-between" mb={2}>
                <Group gap="xs">
                  <Text size="sm">{med.name}</Text>
                  {med.lifeCritical && (
                    <Badge color="red" size="xs">
                      critical
                    </Badge>
                  )}
                </Group>
                <Text size="sm" c="dimmed">
                  {pct === null ? 'no logs' : `${pct}% · ${taken} taken / ${notDone} not taken`}
                </Text>
              </Group>
              <Progress value={pct ?? 0} color={pct !== null && pct >= 90 ? 'teal' : pct !== null && pct >= 70 ? 'yellow' : 'red'} />
            </div>
          ))}
          {stats.perMed.length === 0 && <Text c="dimmed">No active medications — add one in the Medplum app.</Text>}
        </Stack>
      </Card>

      <Card withBorder>
        <Title order={4} mb="sm">
          Last 13 weeks
        </Title>
        <Heatmap days={days} />
      </Card>
    </Stack>
  );
}

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
    <Card withBorder>
      <Title order={4} mb="sm">
        Due now
      </Title>
      <Stack gap="xs">
        {due.map((def) => (
          <Group key={def.questionnaire.url} justify="space-between">
            <Group gap="xs">
              <Text size="sm">{def.questionnaire.title}</Text>
              <Badge size="xs" variant="light">
                {CADENCE_LABEL[def.cadence]}
              </Badge>
            </Group>
            <Button size="compact-sm" component={Link} to="/checkin">
              Check in
            </Button>
          </Group>
        ))}
        {followUps.map((task) => (
          <Group key={task.id} justify="space-between">
            <Group gap="xs">
              <Badge size="xs" color="grape" variant="light">
                follow-up
              </Badge>
              <Text size="sm">{task.description}</Text>
              {task.executionPeriod?.end && (
                <Text size="xs" c="dimmed">
                  due {task.executionPeriod.end.slice(0, 10)}
                </Text>
              )}
            </Group>
            <Group gap={6}>
              <Button size="compact-sm" variant="light" component={Link} to="/log">
                Log update
              </Button>
              <Button size="compact-sm" variant="subtle" color="teal" onClick={() => resolve(task)}>
                Resolved
              </Button>
            </Group>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card withBorder>
      <Text size="xs" c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text size="xl" fw={700}>
        {value}
      </Text>
    </Card>
  );
}

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

  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        {props.title}
      </Title>
      <Stack gap="xs">
        {slots.map((slot) => {
          const admin = adminForSlot(props.admins, slot);
          const isFuture = slot.scheduled.getTime() > props.now.getTime();
          const overdue =
            !admin &&
            !isFuture &&
            props.now.getTime() - slot.scheduled.getTime() > OVERDUE_GRACE_MINUTES * 60_000;
          return (
            <Group key={slot.identValue} justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap">
                <Text fw={600} w={52}>
                  {slot.time.slice(0, 5)}
                </Text>
                <Text size="sm">{slot.med.name}</Text>
                {slot.med.lifeCritical && (
                  <Badge color="red" size="xs">
                    critical
                  </Badge>
                )}
                {admin?.status === 'completed' && <Badge color="teal">taken</Badge>}
                {admin?.status === 'not-done' && (
                  <Badge color="red">
                    {admin.statusReason?.[0]?.coding?.[0]?.code === 'user-marked-missed' ? 'missed' : 'skipped'}
                  </Badge>
                )}
                {!admin && isFuture && <Badge color="gray">upcoming</Badge>}
                {overdue && <Badge color="orange">overdue</Badge>}
              </Group>
              <Group gap={6} wrap="nowrap">
                {!admin && !isFuture && (
                  <>
                    <Button
                      size="compact-sm"
                      loading={busy === slot.identValue}
                      onClick={() => act(slot, 'taken')}
                    >
                      Taken
                    </Button>
                    <Button
                      size="compact-sm"
                      variant="light"
                      color="yellow"
                      loading={busy === slot.identValue}
                      onClick={() => act(slot, 'skipped')}
                    >
                      Skip
                    </Button>
                    <Button
                      size="compact-sm"
                      variant="light"
                      color="red"
                      loading={busy === slot.identValue}
                      onClick={() => act(slot, 'missed')}
                    >
                      Missed
                    </Button>
                  </>
                )}
                {admin && (
                  <Menu>
                    <Menu.Target>
                      <Button size="compact-sm" variant="subtle">
                        change
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item onClick={() => act(slot, 'taken')}>Mark taken</Menu.Item>
                      <Menu.Item onClick={() => act(slot, 'skipped')}>Mark skipped</Menu.Item>
                      <Menu.Item onClick={() => act(slot, 'missed')}>Mark missed</Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                )}
              </Group>
            </Group>
          );
        })}
      </Stack>
    </Card>
  );
}
