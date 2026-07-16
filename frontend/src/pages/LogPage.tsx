import { NumberInput, Slider, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import {
  IconHeartbeat,
  IconMessageQuestion,
  IconMoodSmile,
  IconMoon,
  IconScale,
  IconStethoscope,
  type Icon,
} from '@tabler/icons-react';
import type { CSSProperties, ReactNode } from 'react';
import { useState } from 'react';
import { DsCard, PageHeader, PillButton } from '../components/ds';
import { CS_OBS, IDENT, LOINC, OBS_CATEGORY, UCUM, getPatient } from '../fhir';
import { T, mono } from '../tokens';

const QUICK_IDENT = `${IDENT}/quick-observation`;

function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function LogPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Quick add"
        subtitle="Everything saves straight into your FHIR record with the time you choose — backdating is fine."
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))',
          gap: 16,
        }}
      >
        <WeightCard />
        <SleepCard />
        <MoodEnergyCard />
        <SymptomCard />
        <VitalsCard />
        <RxQuestionCard />
      </div>
    </div>
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

// ---------------------------------------------------------------------------
// Presentation shell — capture-tile card language (Ingestion Suite 1a, manual entry)
// ---------------------------------------------------------------------------

const inputStyles = {
  input: {
    background: T.band,
    border: 'none',
    borderRadius: 12,
    minHeight: 40,
    height: 40,
    fontSize: 13.5,
    color: T.ink,
  } as CSSProperties,
};

/** Numbers / timestamps render in IBM Plex Mono. */
const monoInputStyles = {
  input: { ...inputStyles.input, fontFamily: T.mono } as CSSProperties,
};

function FieldLabel({ children }: { children: ReactNode }) {
  return <span style={{ ...mono(10, 500, T.quaternary), letterSpacing: '.04em' }}>{children}</span>;
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <FieldLabel>{props.label}</FieldLabel>
      {props.children}
    </div>
  );
}

function CardShell(props: { icon: Icon; title: string; sub: string; children: ReactNode }) {
  const IconCmp = props.icon;
  return (
    <DsCard padding={20} gap={14}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            background: T.band,
            color: T.ink,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
          }}
        >
          <IconCmp size={16} stroke={1.7} />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-.01em' }}>
            {props.title}
          </span>
          <span style={mono(10, 400, T.tertiary)}>{props.sub}</span>
        </div>
      </div>
      <div style={{ height: 1, background: T.chip }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
        {props.children}
      </div>
    </DsCard>
  );
}

function SaveButton(props: {
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <PillButton
      variant="primary"
      size={12.5}
      onClick={props.onClick}
      disabled={props.busy || props.disabled}
      style={{ alignSelf: 'flex-start', marginTop: 'auto' }}
    >
      {props.busy ? 'Saving…' : props.children}
    </PillButton>
  );
}

function WhenInput(props: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="When">
      <TextInput
        type="datetime-local"
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
        styles={monoInputStyles}
      />
    </Field>
  );
}

function useSubmit(save: () => Promise<void>, label: string) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await save();
      notifications.show({ color: 'hmdGreen', message: `${label} saved` });
    } catch (err) {
      notifications.show({ color: 'hmdRed', title: `Could not save ${label.toLowerCase()}`, message: normalizeErrorString(err) });
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
    <CardShell icon={IconScale} title="Weight" sub="kg · backdatable">
      <Field label="Weight (kg)">
        <NumberInput
          value={kg}
          onChange={setKg}
          decimalScale={1}
          min={1}
          max={400}
          hideControls
          styles={monoInputStyles}
        />
      </Field>
      <WhenInput value={when} onChange={setWhen} />
      <SaveButton onClick={submit} busy={busy} disabled={!kg}>
        Save weight
      </SaveButton>
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
    <CardShell icon={IconMoon} title="Sleep" sub="hours slept · backdatable">
      <Field label="Hours slept">
        <NumberInput
          value={hours}
          onChange={setHours}
          decimalScale={1}
          min={0}
          max={24}
          hideControls
          styles={monoInputStyles}
        />
      </Field>
      <WhenInput value={when} onChange={setWhen} />
      <SaveButton onClick={submit} busy={busy} disabled={!hours}>
        Save sleep
      </SaveButton>
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
    <CardShell icon={IconMoodSmile} title="Mood & energy" sub="mood + energy · 1–10">
      <SliderRow label="Mood" value={mood} onChange={setMood} />
      <SliderRow label="Energy" value={energy} onChange={setEnergy} />
      <WhenInput value={when} onChange={setWhen} />
      <SaveButton onClick={submit} busy={busy}>
        Save mood &amp; energy
      </SaveButton>
    </CardShell>
  );
}

function SliderRow(props: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12.5, fontWeight: 500 }}>{props.label}</span>
        <span style={mono(12, 500, T.ink)}>{props.value}/10</span>
      </div>
      <Slider min={1} max={10} value={props.value} onChange={props.onChange} size="sm" />
    </div>
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
    <CardShell icon={IconHeartbeat} title="Vitals" sub="BP · HR · temp · SpO2 · glucose">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        {VITALS.map((field) => (
          <Field key={field.key} label={field.label}>
            <NumberInput
              value={values[field.key] ?? ''}
              onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
              min={field.min}
              max={field.max}
              decimalScale={'decimals' in field ? field.decimals : 0}
              hideControls
              placeholder={`${field.min}–${field.max}`}
              styles={monoInputStyles}
            />
          </Field>
        ))}
      </div>
      <WhenInput value={when} onChange={setWhen} />
      <SaveButton onClick={submit} busy={busy}>
        Save vitals
      </SaveButton>
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
    <CardShell icon={IconMessageQuestion} title="Question for your clinician" sub="free text · saved with today's time">
      <span style={{ fontSize: 12, lineHeight: 1.5, color: T.secondary }}>
        Jot it down now — it lands in the clinician summary so you remember to raise it at the
        appointment.
      </span>
      <Field label="What do you want to ask?">
        <TextInput
          placeholder="e.g. is the morning nausea expected to fade?"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          styles={inputStyles}
        />
      </Field>
      <SaveButton onClick={submit} busy={busy} disabled={!text.trim()}>
        Save question
      </SaveButton>
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
    <CardShell icon={IconStethoscope} title="Symptom / side effect" sub="free text · backdatable">
      <Field label="What happened?">
        <TextInput
          placeholder="e.g. mild headache after lunch"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          styles={inputStyles}
        />
      </Field>
      <WhenInput value={when} onChange={setWhen} />
      <SaveButton onClick={submit} busy={busy} disabled={!text.trim()}>
        Save symptom
      </SaveButton>
    </CardShell>
  );
}
