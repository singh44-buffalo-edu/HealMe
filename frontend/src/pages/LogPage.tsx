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
        <VitalsCard />
        <RxQuestionCard />
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

// Verified LOINC only (per FHIR-MAPPING rules); plausible-range validation
// from the ingestion-module spec §12.12. No clinical thresholds — trends are
// displayed without judgment until thresholds are set with a clinician.
const VITALS = [
  { key: 'systolic', label: 'Systolic (mm Hg)', min: 70, max: 260 },
  { key: 'diastolic', label: 'Diastolic (mm Hg)', min: 40, max: 160 },
  { key: 'hr', label: 'Heart rate (/min)', min: 30, max: 220 },
  { key: 'temp', label: 'Temperature (°C)', min: 34, max: 42, decimals: 1 },
  { key: 'spo2', label: 'SpO2 (%)', min: 70, max: 100 },
  { key: 'glucose', label: 'Glucose (mg/dL)', min: 40, max: 500 },
] as const;

function VitalsCard() {
  const saveObs = useSaveObservation();
  const [values, setValues] = useState<Record<string, number | string>>({});
  const [when, setWhen] = useState(nowLocalInput());
  const { busy, submit } = useSubmit(async () => {
    const v = (key: string) => {
      const raw = values[key];
      return raw === '' || raw === undefined ? undefined : Number(raw);
    };
    for (const field of VITALS) {
      const value = v(field.key);
      if (value !== undefined && (value < field.min || value > field.max)) {
        throw new Error(`${field.label}: expected ${field.min}–${field.max}`);
      }
    }
    const sys = v('systolic');
    const dia = v('diastolic');
    if ((sys === undefined) !== (dia === undefined)) {
      throw new Error('Blood pressure needs both systolic and diastolic');
    }
    const effectiveDateTime = toIso(when);
    const vitalsCat = [{ coding: [{ system: OBS_CATEGORY, code: 'vital-signs' }] }];
    const quantity = (value: number, unit: string, ucum: string) => ({
      value,
      unit,
      system: UCUM,
      code: ucum,
    });
    const observations: Observation[] = [];
    if (sys !== undefined && dia !== undefined) {
      observations.push({
        resourceType: 'Observation',
        status: 'final',
        category: vitalsCat,
        code: { coding: [{ system: LOINC, code: '85354-9', display: 'Blood pressure panel' }] },
        effectiveDateTime,
        component: [
          {
            code: { coding: [{ system: LOINC, code: '8480-6', display: 'Systolic blood pressure' }] },
            valueQuantity: quantity(sys, 'mmHg', 'mm[Hg]'),
          },
          {
            code: { coding: [{ system: LOINC, code: '8462-4', display: 'Diastolic blood pressure' }] },
            valueQuantity: quantity(dia, 'mmHg', 'mm[Hg]'),
          },
        ],
      } as Observation);
    }
    const simple: [string, string, string, string, string][] = [
      // key, loinc, display, unit label, ucum
      ['hr', '8867-4', 'Heart rate', '/min', '/min'],
      ['temp', '8310-5', 'Body temperature', '°C', 'Cel'],
      ['spo2', '59408-5', 'Oxygen saturation (pulse oximetry)', '%', '%'],
      ['glucose', '2339-0', 'Glucose', 'mg/dL', 'mg/dL'],
    ];
    for (const [key, code, display, unit, ucum] of simple) {
      const value = v(key);
      if (value !== undefined) {
        observations.push({
          resourceType: 'Observation',
          status: 'final',
          category: vitalsCat,
          code: { coding: [{ system: LOINC, code, display }] },
          effectiveDateTime,
          valueQuantity: quantity(value, unit, ucum),
        } as Observation);
      }
    }
    if (observations.length === 0) throw new Error('Enter at least one vital');
    await saveObs((patientRef) =>
      observations.map((o) => ({ ...o, subject: { reference: patientRef } }))
    );
    setValues({});
  }, 'Vitals');

  return (
    <CardShell title="Vitals (BP · HR · temp · SpO2 · glucose)">
      <Stack gap="xs">
        <SimpleGrid cols={2}>
          {VITALS.map((field) => (
            <NumberInput
              key={field.key}
              label={field.label}
              value={values[field.key] ?? ''}
              onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
              min={field.min}
              max={field.max}
              decimalScale={'decimals' in field ? field.decimals : 0}
            />
          ))}
        </SimpleGrid>
        <WhenInput value={when} onChange={setWhen} />
        <Button onClick={submit} loading={busy}>
          Save vitals
        </Button>
      </Stack>
    </CardShell>
  );
}

function RxQuestionCard() {
  const saveObs = useSaveObservation();
  const [text, setText] = useState('');
  const { busy, submit } = useSubmit(async () => {
    if (!text.trim()) throw new Error('Write the question first');
    await saveObs((patientRef) => [
      {
        resourceType: 'Observation',
        status: 'final',
        category: [{ coding: [{ system: OBS_CATEGORY, code: 'survey' }] }],
        code: {
          coding: [{ system: CS_OBS, code: 'rx-question', display: 'Question for prescriber' }],
          text: 'Question for prescriber',
        },
        subject: { reference: patientRef },
        effectiveDateTime: new Date().toISOString(),
        valueString: text.trim(),
      },
    ]);
    setText('');
  }, 'Question for your clinician');

  return (
    <CardShell title="Question for your clinician">
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          Jot it down now — it lands in the clinician summary so you remember to raise it at the
          appointment.
        </Text>
        <TextInput
          label="What do you want to ask?"
          placeholder="e.g. is the morning nausea expected to fade?"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <Button onClick={submit} loading={busy} disabled={!text.trim()}>
          Save question
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
