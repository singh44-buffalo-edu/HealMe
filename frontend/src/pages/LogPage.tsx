import {
  Button,
  Card,
  Group,
  NumberInput,
  SimpleGrid,
  Slider,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useState } from 'react';
import { CS_OBS, IDENT, LOINC, OBS_CATEGORY, UCUM, getPatient } from '../fhir';

const QUICK_IDENT = `${IDENT}/quick-observation`;

function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function LogPage() {
  return (
    <Stack>
      <Title order={2}>Quick add</Title>
      <Text c="dimmed" size="sm">
        Everything saves straight into your FHIR record with the time you choose — backdating is fine.
      </Text>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <WeightCard />
        <SleepCard />
        <MoodEnergyCard />
        <SymptomCard />
      </SimpleGrid>
    </Stack>
  );
}

function useSaveObservation() {
  const medplum = useMedplum();
  return async (build: (patientRef: string) => Observation[]) => {
    const patient = await getPatient(medplum);
    if (!patient) throw new Error('No patient record — run make seed');
    for (const obs of build(`Patient/${patient.id}`)) {
      await medplum.createResource<Observation>({
        ...obs,
        identifier: [{ system: QUICK_IDENT, value: crypto.randomUUID() }],
      });
    }
  };
}

function toIso(local: string): string {
  return new Date(local).toISOString();
}

function CardShell(props: { title: string; children: React.ReactNode }) {
  return (
    <Card withBorder>
      <Title order={5} mb="sm">
        {props.title}
      </Title>
      {props.children}
    </Card>
  );
}

function WhenInput(props: { value: string; onChange: (v: string) => void }) {
  return (
    <TextInput
      label="When"
      type="datetime-local"
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value)}
    />
  );
}

function useSubmit(save: () => Promise<void>, label: string) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await save();
      notifications.show({ color: 'teal', message: `${label} saved` });
    } catch (err) {
      notifications.show({ color: 'red', title: `Could not save ${label.toLowerCase()}`, message: normalizeErrorString(err) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, submit };
}

function WeightCard() {
  const saveObs = useSaveObservation();
  const [kg, setKg] = useState<number | string>('');
  const [when, setWhen] = useState(nowLocalInput());
  const { busy, submit } = useSubmit(async () => {
    const value = Number(kg);
    if (!value || value <= 0 || value > 400) throw new Error('Enter a weight in kg');
    await saveObs((patientRef) => [
      {
        resourceType: 'Observation',
        status: 'final',
        category: [{ coding: [{ system: OBS_CATEGORY, code: 'vital-signs' }] }],
        code: { coding: [{ system: LOINC, code: '29463-7', display: 'Body weight' }] },
        subject: { reference: patientRef },
        effectiveDateTime: toIso(when),
        valueQuantity: { value, unit: 'kg', system: UCUM, code: 'kg' },
      },
    ]);
    setKg('');
  }, 'Weight');

  return (
    <CardShell title="Weight">
      <Stack gap="xs">
        <NumberInput label="Weight (kg)" value={kg} onChange={setKg} decimalScale={1} min={1} max={400} />
        <WhenInput value={when} onChange={setWhen} />
        <Button onClick={submit} loading={busy} disabled={!kg}>
          Save weight
        </Button>
      </Stack>
    </CardShell>
  );
}

function SleepCard() {
  const saveObs = useSaveObservation();
  const [hours, setHours] = useState<number | string>('');
  const [when, setWhen] = useState(nowLocalInput());
  const { busy, submit } = useSubmit(async () => {
    const value = Number(hours);
    if (!value || value <= 0 || value > 24) throw new Error('Enter hours slept');
    await saveObs((patientRef) => [
      {
        resourceType: 'Observation',
        status: 'final',
        category: [{ coding: [{ system: OBS_CATEGORY, code: 'survey' }] }],
        code: { coding: [{ system: CS_OBS, code: 'sleep-duration', display: 'Sleep duration' }] },
        subject: { reference: patientRef },
        effectiveDateTime: toIso(when),
        valueQuantity: { value, unit: 'h', system: UCUM, code: 'h' },
      },
    ]);
    setHours('');
  }, 'Sleep');

  return (
    <CardShell title="Sleep">
      <Stack gap="xs">
        <NumberInput label="Hours slept" value={hours} onChange={setHours} decimalScale={1} min={0} max={24} />
        <WhenInput value={when} onChange={setWhen} />
        <Button onClick={submit} loading={busy} disabled={!hours}>
          Save sleep
        </Button>
      </Stack>
    </CardShell>
  );
}

function MoodEnergyCard() {
  const saveObs = useSaveObservation();
  const [mood, setMood] = useState(5);
  const [energy, setEnergy] = useState(5);
  const [when, setWhen] = useState(nowLocalInput());
  const { busy, submit } = useSubmit(async () => {
    await saveObs((patientRef) =>
      (
        [
          ['mood', mood],
          ['energy', energy],
        ] as const
      ).map(([code, value]) => ({
        resourceType: 'Observation' as const,
        status: 'final' as const,
        category: [{ coding: [{ system: OBS_CATEGORY, code: 'survey' }] }],
        code: { coding: [{ system: CS_OBS, code, display: `${code} (1-10)` }] },
        subject: { reference: patientRef },
        effectiveDateTime: toIso(when),
        valueInteger: value,
      }))
    );
  }, 'Mood & energy');

  return (
    <CardShell title="Mood & energy">
      <Stack gap="xs">
        <Text size="sm">Mood: {mood}/10</Text>
        <Slider min={1} max={10} value={mood} onChange={setMood} />
        <Text size="sm">Energy: {energy}/10</Text>
        <Slider min={1} max={10} value={energy} onChange={setEnergy} />
        <WhenInput value={when} onChange={setWhen} />
        <Button onClick={submit} loading={busy}>
          Save mood & energy
        </Button>
      </Stack>
    </CardShell>
  );
}

function SymptomCard() {
  const saveObs = useSaveObservation();
  const [text, setText] = useState('');
  const [when, setWhen] = useState(nowLocalInput());
  const { busy, submit } = useSubmit(async () => {
    if (!text.trim()) throw new Error('Describe the symptom');
    await saveObs((patientRef) => [
      {
        resourceType: 'Observation',
        status: 'final',
        category: [{ coding: [{ system: OBS_CATEGORY, code: 'survey' }] }],
        code: { coding: [{ system: CS_OBS, code: 'symptom', display: 'Symptom' }], text: 'Symptom' },
        subject: { reference: patientRef },
        effectiveDateTime: toIso(when),
        valueString: text.trim(),
      },
    ]);
    setText('');
  }, 'Symptom');

  return (
    <CardShell title="Symptom / side effect">
      <Stack gap="xs">
        <TextInput
          label="What happened?"
          placeholder="e.g. mild headache after lunch"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <WhenInput value={when} onChange={setWhen} />
        <Group>
          <Button onClick={submit} loading={busy} disabled={!text.trim()}>
            Save symptom
          </Button>
        </Group>
      </Stack>
    </CardShell>
  );
}
