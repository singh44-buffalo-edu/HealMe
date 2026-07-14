/**
 * FHIR helpers for the HealMeDaily frontend. Canonical mapping: FHIR-MAPPING.md.
 * Every write is idempotent (stable identifier + search-before-create) so
 * retries and double-taps never double-log.
 */

import { MedplumClient } from '@medplum/core';
import type {
  Device,
  Medication,
  MedicationAdministration,
  MedicationRequest,
  Patient,
  Resource,
} from '@medplum/fhirtypes';

export const BASE = 'https://healmedaily.local/fhir';
export const IDENT = `${BASE}/identifier`;
export const CS_OBS = `${BASE}/CodeSystem/observation`;
export const CS_ADHERENCE = `${BASE}/CodeSystem/adherence-reason`;
export const CS_DEVICE = `${BASE}/CodeSystem/device`;
export const EXT_LIFE_CRITICAL = `${BASE}/StructureDefinition/medicationrequest-life-critical`;
export const EXT_DEVICE_MED = `${BASE}/StructureDefinition/device-assigned-medication`;
export const EXT_SUPPLY_TARGET = `${BASE}/StructureDefinition/supplydelivery-target-cartridge`;
export const Q_URL = `${BASE}/Questionnaire/daily-check-in`;
export const OBS_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';
export const LOINC = 'http://loinc.org';
export const UCUM = 'http://unitsofmeasure.org';
export const PATIENT_IDENT = `${IDENT}/patient|healmedaily-user`;

const ADMIN_IDENT_SYSTEM = `${IDENT}/medication-administration`;

export const OVERDUE_GRACE_MINUTES = 90;

// ---------------------------------------------------------------------------

export interface CartridgeInfo {
  device: Device;
  name: string;
  enabled: boolean;
  medicationRef?: string;
  capacity?: number;
  remaining?: number;
  lowThreshold?: number;
  low: boolean;
}

export interface MedInfo {
  request: MedicationRequest;
  name: string;
  instructions: string;
  lifeCritical: boolean;
  times: string[]; // HH:MM:SS
  cartridge?: CartridgeInfo;
}

export function getPatient(medplum: MedplumClient): Promise<Patient | undefined> {
  return medplum.searchOne('Patient', { identifier: PATIENT_IDENT });
}

function deviceProp(device: Device, code: string): number | undefined {
  const prop = device.property?.find((p) => p.type?.coding?.some((c) => c.code === code));
  return prop?.valueQuantity?.[0]?.value;
}

export function toCartridgeInfo(device: Device): CartridgeInfo {
  const capacity = deviceProp(device, 'capacity');
  const remaining = deviceProp(device, 'remaining-count');
  const lowThreshold = deviceProp(device, 'low-stock-threshold');
  return {
    device,
    name: device.deviceName?.[0]?.name ?? 'Cartridge',
    enabled: device.status === 'active',
    medicationRef: device.extension?.find((e) => e.url === EXT_DEVICE_MED)?.valueReference?.reference,
    capacity,
    remaining,
    lowThreshold,
    low: remaining !== undefined && lowThreshold !== undefined && remaining <= lowThreshold,
  };
}

export async function loadCartridges(medplum: MedplumClient): Promise<CartridgeInfo[]> {
  const devices = await medplum.searchResources('Device', {
    type: `${CS_DEVICE}|medication-cartridge`,
    _count: '50',
  });
  return devices.map(toCartridgeInfo);
}

export async function loadMeds(medplum: MedplumClient): Promise<MedInfo[]> {
  const bundle = await medplum.search('MedicationRequest', {
    status: 'active',
    _include: 'MedicationRequest:medication',
    _count: '100',
  });
  const medications = new Map<string, Medication>();
  const requests: MedicationRequest[] = [];
  for (const entry of bundle.entry ?? []) {
    // _include mixes Medication resources into a Bundle typed as MedicationRequest
    const res = entry.resource as Resource | undefined;
    if (res?.resourceType === 'Medication') medications.set(res.id as string, res);
    if (res?.resourceType === 'MedicationRequest') requests.push(res);
  }
  const cartridges = await loadCartridges(medplum);

  return requests.map((request) => {
    const medId = request.medicationReference?.reference?.split('/')[1];
    const medication = medId ? medications.get(medId) : undefined;
    const dosage = request.dosageInstruction?.[0];
    return {
      request,
      name: medication?.code?.text ?? 'Unnamed medication',
      instructions: dosage?.text ?? '',
      lifeCritical:
        request.extension?.some((e) => e.url === EXT_LIFE_CRITICAL && e.valueBoolean) ?? false,
      times: dosage?.timing?.repeat?.timeOfDay ?? [],
      cartridge: cartridges.find(
        (c) => c.enabled && c.medicationRef === request.medicationReference?.reference
      ),
    };
  });
}

// --- Dose slots & logging ---------------------------------------------------

export interface DoseSlot {
  med: MedInfo;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  identValue: string;
  scheduled: Date;
}

function requestSlugBase(request: MedicationRequest): string {
  const local = request.identifier?.find((i) => i.system === `${IDENT}/medication-request`);
  return local?.value ?? (request.id as string);
}

export function slotIdentValue(med: MedInfo, date: string, time: string): string {
  return `${requestSlugBase(med.request)}-${date}T${time.slice(0, 5)}`;
}

export function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function slotsForDate(meds: MedInfo[], date: string): DoseSlot[] {
  const slots: DoseSlot[] = [];
  for (const med of meds) {
    for (const time of med.times) {
      slots.push({
        med,
        date,
        time,
        identValue: slotIdentValue(med, date, time),
        scheduled: new Date(`${date}T${time}`),
      });
    }
  }
  return slots.sort((a, b) => a.time.localeCompare(b.time));
}

export async function loadAdmins(
  medplum: MedplumClient,
  days: number
): Promise<MedicationAdministration[]> {
  const start = new Date();
  start.setDate(start.getDate() - days);
  return medplum.searchResources('MedicationAdministration', {
    'effective-time': `ge${localDateString(start)}`,
    _count: '1000',
  });
}

export function adminForSlot(
  admins: MedicationAdministration[],
  slot: DoseSlot
): MedicationAdministration | undefined {
  return admins.find((a) =>
    a.identifier?.some((i) => i.system === ADMIN_IDENT_SYSTEM && i.value === slot.identValue)
  );
}

export type DoseAction = 'taken' | 'skipped' | 'missed';

const REASON_CODE: Record<Exclude<DoseAction, 'taken'>, { code: string; display: string }> = {
  skipped: { code: 'user-skipped', display: 'Skipped by user' },
  missed: { code: 'user-marked-missed', display: 'Marked missed by user' },
};

/** Log (or change) one logical dose event. Idempotent per (request, slot). */
export async function logDose(
  medplum: MedplumClient,
  patientId: string,
  slot: DoseSlot,
  action: DoseAction,
  takenAt?: Date
): Promise<MedicationAdministration> {
  const existing = await medplum.searchOne('MedicationAdministration', {
    identifier: `${ADMIN_IDENT_SYSTEM}|${slot.identValue}`,
  });

  const base: MedicationAdministration = {
    resourceType: 'MedicationAdministration',
    status: action === 'taken' ? 'completed' : 'not-done',
    subject: { reference: `Patient/${patientId}` },
    medicationReference: slot.med.request.medicationReference,
    request: { reference: `MedicationRequest/${slot.med.request.id}` },
    effectiveDateTime:
      action === 'taken' ? (takenAt ?? new Date()).toISOString() : slot.scheduled.toISOString(),
    identifier: [{ system: ADMIN_IDENT_SYSTEM, value: slot.identValue }],
  };
  if (action !== 'taken') {
    base.statusReason = [
      { coding: [{ system: CS_ADHERENCE, ...REASON_CODE[action] }] },
    ];
  }
  if (action === 'taken' && slot.med.cartridge) {
    base.device = [{ reference: `Device/${slot.med.cartridge.device.id}` }];
  }

  const wasTaken = existing?.status === 'completed';
  const result = existing
    ? await medplum.updateResource({ ...base, id: existing.id, meta: existing.meta })
    : await medplum.createResource(base);

  // Display-only inventory: decrement on a new "taken" (never below zero).
  if (action === 'taken' && !wasTaken && slot.med.cartridge?.remaining !== undefined) {
    const cart = slot.med.cartridge;
    const device = await medplum.readResource('Device', cart.device.id as string);
    const prop = device.property?.find((p) =>
      p.type?.coding?.some((c) => c.code === 'remaining-count')
    );
    if (prop?.valueQuantity?.[0]?.value !== undefined && prop.valueQuantity[0].value > 0) {
      prop.valueQuantity[0].value -= 1;
      await medplum.updateResource(device);
    }
  }
  return result;
}

// --- Adherence aggregates ----------------------------------------------------

export type DayStatus = 'all-taken' | 'partial' | 'none-taken' | 'unlogged' | 'no-doses';

export interface DaySummary {
  date: string;
  scheduled: number;
  taken: number;
  notDone: number;
  status: DayStatus;
}

export function summarizeDays(
  meds: MedInfo[],
  admins: MedicationAdministration[],
  days: number
): DaySummary[] {
  const out: DaySummary[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const date = localDateString(d);
    const slots = slotsForDate(meds, date);
    let taken = 0;
    let notDone = 0;
    for (const slot of slots) {
      const admin = adminForSlot(admins, slot);
      if (admin?.status === 'completed') taken++;
      else if (admin?.status === 'not-done') notDone++;
    }
    let status: DayStatus = 'no-doses';
    if (slots.length > 0) {
      if (taken === slots.length) status = 'all-taken';
      else if (taken > 0) status = 'partial';
      else if (notDone > 0) status = 'none-taken';
      else status = 'unlogged';
    }
    out.push({ date, scheduled: slots.length, taken, notDone, status });
  }
  return out;
}

export interface AdherenceStats {
  taken: number;
  notDone: number;
  pct: number | null; // of logged doses
  streak: number; // consecutive fully-taken days (ending today or yesterday)
  perMed: { med: MedInfo; taken: number; notDone: number; pct: number | null }[];
}

export function adherenceStats(
  meds: MedInfo[],
  admins: MedicationAdministration[],
  daySummaries: DaySummary[]
): AdherenceStats {
  const counts = (filter: (a: MedicationAdministration) => boolean) => {
    const relevant = admins.filter(filter);
    const taken = relevant.filter((a) => a.status === 'completed').length;
    const notDone = relevant.filter((a) => a.status === 'not-done').length;
    const logged = taken + notDone;
    return { taken, notDone, pct: logged ? Math.round((100 * taken) / logged) : null };
  };
  const overall = counts(() => true);

  const perMed = meds.map((med) => ({
    med,
    ...counts((a) => a.request?.reference === `MedicationRequest/${med.request.id}`),
  }));

  let streak = 0;
  const chronological = [...daySummaries].reverse(); // today first
  for (let i = 0; i < chronological.length; i++) {
    const day = chronological[i];
    if (i === 0 && day.status !== 'all-taken') continue; // today may be mid-day
    if (day.status === 'all-taken') streak++;
    else if (day.status !== 'no-doses') break;
  }

  return { ...overall, streak, perMed };
}
