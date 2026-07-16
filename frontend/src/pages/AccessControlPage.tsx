/**
 * Access Control — the owner's sharing view ("Who sees my health").
 * Design ground truth: design_handoff_healmedaily / "Web - Access Control".
 * Data model: FHIR-MAPPING.md §10 — every member is a ProjectMembership whose
 * access[] binds a scoped read-only AccessPolicy named
 * `care-circle/{role}/{email}[|expires=YYYY-MM-DD]`. The scope→rule map below
 * mirrors scripts/care_circle.py SCOPE_RULES exactly, so toggles here and the
 * CLI rewrite the very same policy rules.
 *
 * How a scope toggle works: each SCOPES entry expands to concrete
 * AccessPolicy.resource[] rules (resourceType + search criteria +
 * readonly:true). Flipping a toggle rebuilds the member's policy resource[]
 * for the new scope set and PUTs the AccessPolicy in place — enforcement is
 * entirely server-side, effective on the member's next request. The `%patient`
 * token in the criteria is a Medplum policy variable, substituted server-side
 * from the membership's access[] parameters (set when care_circle.py creates
 * the member), so one rule shape serves every member.
 *
 * Invariants: every rule this page writes is readonly:true (care circle is
 * read-only, always); member CREATION stays in the CLI on purpose — this UI
 * can only narrow, widen within SCOPES, or revoke, never mint credentials.
 * The caretaker's own UI renders server denial; nothing here client-filters.
 */

import { Loader, Modal } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { getDisplayString, normalizeErrorString } from '@medplum/core';
import type { MedplumClient } from '@medplum/core';
import type {
  AccessPolicy,
  AccessPolicyResource,
  AuditEvent,
  Basic,
  ProjectMembership,
  Reference,
} from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconHistory, IconPlus, IconShieldCheck } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { CardTitle, DsCard, PageHeader, PillButton, StatusDot } from '../components/ds';
import { BASE, CS_OBS, IDENT } from '../fhir';
import { T, mono } from '../tokens';

// ---------------------------------------------------------------------------
// Care-circle constants (FHIR-MAPPING.md §10 · scripts/care_circle.py)
// ---------------------------------------------------------------------------

const CS_CARE = `${BASE}/CodeSystem/care-circle`;
const EXT_SCOPES = `${BASE}/StructureDefinition/care-circle-scopes`;
const EMERGENCY_POLICY_NAME = 'care-circle/emergency-24h';

interface ScopeDef {
  key: string;
  label: string;
  detail: string;
  rules: { resourceType: string; criteria?: string }[];
}

/** Mirror of care_circle.py SCOPE_RULES — same resource types, same %patient
 * criteria. Labels/details are the human words shown in the UI. */
const SCOPES: ScopeDef[] = [
  {
    key: 'meds',
    label: 'Medications',
    detail: 'doses, adherence, refills, cartridges',
    rules: [
      { resourceType: 'Medication' },
      { resourceType: 'MedicationRequest', criteria: 'MedicationRequest?subject=%patient' },
      {
        resourceType: 'MedicationAdministration',
        criteria: 'MedicationAdministration?subject=%patient',
      },
      { resourceType: 'Device' },
    ],
  },
  {
    key: 'vitals',
    label: 'Vitals',
    detail: 'blood pressure, heart rate, weight',
    rules: [{ resourceType: 'Observation', criteria: 'Observation?subject=%patient&category=vital-signs' }],
  },
  {
    key: 'labs',
    label: 'Labs',
    detail: 'panels and lab reports',
    rules: [
      { resourceType: 'Observation', criteria: 'Observation?subject=%patient&category=laboratory' },
      { resourceType: 'DiagnosticReport', criteria: 'DiagnosticReport?subject=%patient' },
    ],
  },
  {
    key: 'checkins',
    label: 'Check-ins',
    detail: 'daily and weekly answers',
    rules: [{ resourceType: 'Observation', criteria: 'Observation?subject=%patient&category=survey' }],
  },
  {
    key: 'symptoms',
    label: 'Symptoms',
    detail: 'what I logged, in my words',
    rules: [{ resourceType: 'Observation', criteria: `Observation?subject=%patient&code=${CS_OBS}|symptom` }],
  },
  {
    key: 'conditions',
    label: 'Conditions',
    detail: 'ongoing problems list',
    rules: [{ resourceType: 'Condition', criteria: 'Condition?subject=%patient' }],
  },
  {
    key: 'documents',
    label: 'Documents & visit notes',
    detail: 'reports, referrals, letters',
    rules: [{ resourceType: 'DocumentReference', criteria: 'DocumentReference?subject=%patient' }],
  },
  {
    key: 'alerts',
    label: 'Alerts & reminders',
    detail: 'missed-dose and check-in nudges',
    rules: [
      { resourceType: 'Communication', criteria: 'Communication?subject=%patient' },
      { resourceType: 'CommunicationRequest', criteria: 'CommunicationRequest?subject=%patient' },
    ],
  },
];

const ROLE_META: Record<string, { label: string; color: string; bg: string }> = {
  caretaker: { label: 'CARETAKER', color: T.green, bg: T.greenTint },
  'alerts-only': { label: 'ALERTS', color: T.watch, bg: T.heatLate },
  'clinician-share': { label: 'CLINICIAN', color: T.metric.bp, bg: '#edf3fa' },
};

function roleMeta(role: string): { label: string; color: string; bg: string } {
  return ROLE_META[role] ?? { label: role.toUpperCase(), color: T.secondary, bg: T.band };
}

// ---------------------------------------------------------------------------
// Policy helpers
// ---------------------------------------------------------------------------

/** Canonical identity of one policy rule (type + criteria) — used to tell
 * scope-managed rules apart from custom ones we must preserve verbatim.
 * (NB: the joiner in the template literal below is a literal NUL byte, not a
 * space — invisible in most editors. It still separates, so keys are unique,
 * but don't retype the line by hand expecting a space to match.) */
function ruleKey(rule: { resourceType: string; criteria?: string }): string {
  return `${rule.resourceType}\u0000${rule.criteria ?? ''}`;
}

// Every rule any scope can produce. Rules NOT in this set were added outside
// this UI (e.g. by hand in the admin app) and survive rebuilds untouched.
const MANAGED_RULE_KEYS = new Set(SCOPES.flatMap((s) => s.rules.map(ruleKey)));

/** Decode `care-circle/{role}/{email}[|expires=YYYY-MM-DD]` (the policy-name
 * convention care_circle.py writes — the name IS the membership metadata).
 * Returns undefined for non-care-circle policies so they never render as
 * members. */
function parsePolicyName(name: string): { role: string; email: string; expires?: string } | undefined {
  if (!name.startsWith('care-circle/')) return undefined;
  let body = name.slice('care-circle/'.length);
  let expires: string | undefined;
  const pipe = body.indexOf('|expires=');
  if (pipe >= 0) {
    expires = body.slice(pipe + '|expires='.length);
    body = body.slice(0, pipe);
  }
  const slash = body.indexOf('/');
  if (slash < 0) return undefined; // e.g. the emergency-24h policy — not a member
  return { role: body.slice(0, slash), email: body.slice(slash + 1), expires };
}

/** Which scopes a policy currently grants: the care-circle-scopes extension is
 * authoritative (care_circle.py writes it); fall back to inferring from rules. */
function scopesFromPolicy(policy: AccessPolicy): string[] {
  const ext = policy.extension?.find((e) => e.url === EXT_SCOPES)?.valueString;
  if (ext !== undefined) {
    const listed = new Set(ext.split(',').map((s) => s.trim()));
    return SCOPES.filter((s) => listed.has(s.key)).map((s) => s.key);
  }
  const present = new Set((policy.resource ?? []).map(ruleKey));
  return SCOPES.filter((s) => s.rules.every((r) => present.has(ruleKey(r)))).map((s) => s.key);
}

/** Rebuild the policy's resource[] for a new scope set: the Patient rule and
 * any rules we do not manage are preserved verbatim; scope rules are written
 * in canonical order with readonly:true and the %patient criteria pattern the
 * existing policies use (care_circle.py build_policy parity). */
function rebuildPolicy(policy: AccessPolicy, scopes: string[]): AccessPolicy {
  const existing = policy.resource ?? [];
  const patientRule: AccessPolicyResource = existing.find((r) => r.resourceType === 'Patient') ?? {
    resourceType: 'Patient',
    criteria: 'Patient?_id=%patient',
    readonly: true,
  };
  const custom = existing.filter((r) => r.resourceType !== 'Patient' && !MANAGED_RULE_KEYS.has(ruleKey(r)));

  const seen = new Set<string>();
  const scopeRules: AccessPolicyResource[] = [];
  for (const scope of SCOPES) {
    if (!scopes.includes(scope.key)) continue;
    for (const rule of scope.rules) {
      const key = ruleKey(rule);
      if (seen.has(key)) continue;
      seen.add(key);
      const built: AccessPolicyResource = { resourceType: rule.resourceType, readonly: true };
      if (rule.criteria) built.criteria = rule.criteria;
      scopeRules.push(built);
    }
  }

  return {
    ...policy,
    resource: [patientRule, ...scopeRules, ...custom],
    extension: [
      ...(policy.extension ?? []).filter((e) => e.url !== EXT_SCOPES),
      { url: EXT_SCOPES, valueString: scopes.join(',') },
    ],
  };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface Member {
  membership: ProjectMembership;
  policy: AccessPolicy;
  role: string;
  email: string;
  expires?: string; // YYYY-MM-DD from the policy-name suffix
  scopes: string[];
  name: string;
  profileRef: string;
}

const ROLE_ORDER = ['caretaker', 'alerts-only', 'clinician-share'];

/**
 * Assemble the member list: every ProjectMembership with a RelatedPerson/
 * Practitioner profile whose bound AccessPolicy follows the care-circle
 * naming convention. Reads policy + profile per membership (N+1 reads —
 * fine at care-circle scale, a handful of people). Dangling policy refs and
 * unreadable profiles degrade gracefully (skip / name fallback) rather than
 * failing the whole page.
 */
async function loadMembers(medplum: MedplumClient): Promise<Member[]> {
  // A single-user project has a handful of memberships; the care-circle
  // filter is by bound-policy name, which is not a search parameter.
  const memberships = await medplum.searchResources('ProjectMembership', { _count: '200' });
  const members: Member[] = [];
  for (const membership of memberships) {
    const profileRef = membership.profile?.reference ?? '';
    const profileType = profileRef.split('/')[0];
    if (profileType !== 'RelatedPerson' && profileType !== 'Practitioner') continue;

    const policyRef = membership.access?.[0]?.policy ?? membership.accessPolicy;
    if (!policyRef?.reference) continue;
    let policy: AccessPolicy;
    try {
      policy = await medplum.readReference(policyRef as Reference<AccessPolicy>);
    } catch {
      continue; // dangling policy reference — not a presentable member
    }
    const parsed = parsePolicyName(policy.name ?? '');
    if (!parsed) continue; // membership bound to some non-care-circle policy

    let name = membership.profile?.display ?? parsed.email;
    let email = parsed.email;
    try {
      const profile = await medplum.readReference(membership.profile);
      name = getDisplayString(profile);
      if ('telecom' in profile) {
        email = profile.telecom?.find((t) => t.system === 'email')?.value ?? parsed.email;
      }
    } catch {
      // keep the display / policy-name fallbacks
    }
    members.push({ membership, policy, ...parsed, name, email, profileRef, scopes: scopesFromPolicy(policy) });
  }
  members.sort((a, b) => {
    const byRole = roleRank(a.role) - roleRank(b.role);
    return byRole !== 0 ? byRole : a.name.localeCompare(b.name);
  });
  return members;
}

function roleRank(role: string): number {
  const i = ROLE_ORDER.indexOf(role);
  return i < 0 ? ROLE_ORDER.length : i;
}

interface AlertRule {
  id: string;
  rule: string;
  detail?: string;
  who: string;
  enabled: boolean;
}

/** Owner alert-rule preferences live in Basic resources (local code
 * alert-rules, FHIR-MAPPING.md §10). Parsed tolerantly; nothing is invented —
 * an empty search renders the quiet empty state. */
function parseAlertRule(basic: Basic): AlertRule {
  const ext = (suffix: string) =>
    basic.extension?.find((e) => e.url === `${BASE}/StructureDefinition/alert-rule-${suffix}`);
  return {
    id: basic.id ?? '',
    rule: ext('label')?.valueString ?? basic.code?.text ?? 'Alert rule',
    detail: ext('detail')?.valueString,
    who: ext('recipient')?.valueString ?? basic.subject?.display ?? '—',
    enabled: ext('enabled')?.valueBoolean ?? true,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function firstName(name: string): string {
  return name.split(' ')[0] || name;
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter((p) => /[a-zA-Z]/.test(p[0] ?? ''));
  const chars = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '');
  return chars.join('') || name.slice(0, 2).toUpperCase();
}

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(`${dateStr}T23:59:59`).getTime() - Date.now()) / 86_400_000);
}

function expiryLabel(expires: string): { text: string; color: string } {
  const days = daysUntil(expires);
  if (days < 0) return { text: 'share ended', color: T.outOfRange };
  if (days <= 1) return { text: 'ends today', color: T.watch };
  return { text: `ends in ${days} days`, color: days <= 7 ? T.watch : T.secondary };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 24h clock (owner decision) — "today 19:50" · "Sun 12:40" · "Jun 21 08:15". */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (dayDiff === 0) return `today ${time}`;
  if (dayDiff === 1) return `yesterday ${time}`;
  if (dayDiff < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/** Human words for what a record-history entry touched — never resource names. */
const ENTITY_WORDS: Record<string, string> = {
  Medication: 'medications',
  MedicationRequest: 'medications',
  MedicationAdministration: 'medications',
  Observation: 'readings',
  DiagnosticReport: 'labs',
  DocumentReference: 'documents',
  Binary: 'documents',
  Condition: 'conditions',
  Communication: 'alerts',
  CommunicationRequest: 'alerts',
  Questionnaire: 'check-ins',
  QuestionnaireResponse: 'check-ins',
  Device: 'cartridges',
  Patient: 'profile',
  ProjectMembership: 'access settings',
  Basic: 'settings',
};

const AGENT_FALLBACK: Record<string, string> = {
  ClientApplication: 'a connected service',
  Practitioner: 'someone with access',
  RelatedPerson: 'someone with access',
  Patient: 'someone with access',
};

function auditWhat(event: AuditEvent): string {
  if (event.type?.code === 'break-glass') {
    return event.subtype?.[0]?.code === 'restore' ? 'emergency access ended' : 'emergency unlock';
  }
  const types = new Set(
    (event.entity ?? [])
      .map((e) => e.what?.reference?.split('/')[0])
      .filter((t): t is string => Boolean(t))
      .map((t) => ENTITY_WORDS[t] ?? 'the record')
  );
  return types.size > 0 ? [...types].join(' + ') : 'the record';
}

// ---------------------------------------------------------------------------
// Local UI primitives (per design recipe — not shared, defined here)
// ---------------------------------------------------------------------------

/** 44×26 scope toggle: track #0f8a63 on / #d9d9d5 off, 20px knob, .15s slide. */
function ToggleSwitch({
  on,
  onToggle,
  disabled = false,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      disabled={disabled}
      style={{
        border: 'none',
        cursor: disabled ? 'wait' : 'pointer',
        width: 44,
        height: 26,
        borderRadius: 14,
        background: on ? T.green : '#d9d9d5',
        position: 'relative',
        padding: 0,
        flexShrink: 0,
        opacity: disabled ? 0.7 : 1,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: on ? 21 : 3,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,.2)',
          transition: 'left .15s ease',
        }}
      />
    </button>
  );
}

function RolePill({ role }: { role: string }) {
  const meta = roleMeta(role);
  return (
    <span
      style={{
        ...mono(9, 500, meta.color),
        letterSpacing: '.08em',
        background: meta.bg,
        borderRadius: 20,
        padding: '3px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
    </span>
  );
}

function Avatar({ name, role, size = 38 }: { name: string; role: string; size?: number }) {
  const meta = roleMeta(role);
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: meta.bg,
        color: meta.color,
        display: 'grid',
        placeItems: 'center',
        fontSize: size >= 44 ? 16 : 13,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initials(name)}
    </span>
  );
}

function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 500,
        color: T.green,
        padding: 0,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

function MonoHint({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <div
      style={{
        ...mono(10.5, 400, dark ? '#d1d1d6' : T.tertiary),
        background: dark ? 'rgba(255,255,255,.08)' : T.band,
        borderRadius: 10,
        padding: '9px 12px',
        lineHeight: 1.7,
        overflowWrap: 'anywhere',
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * "Who sees my health": member cards with per-scope toggles, alert rules,
 * emergency (break-glass) status, and the who-looked-lately audit trail.
 *
 * FHIR touched: reads ProjectMembership + AccessPolicy + profiles (members),
 * AccessPolicy (emergency), AuditEvent (break-glass count via _total=accurate
 * — counts are NOT returned by default, CLAUDE.md §5; plus the last 30 days
 * for "who looked"), Basic (alert rules). Writes: AccessPolicy updates
 * (scope toggles), ProjectMembership deletes (revoke). Member creation is
 * CLI-only by design.
 */
export function AccessControlPage() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();

  const [members, setMembers] = useState<Member[]>([]);
  const [emergencyPolicy, setEmergencyPolicy] = useState<AccessPolicy>();
  const [breakGlassUses, setBreakGlassUses] = useState<number>();
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const [expandedId, setExpandedId] = useState<string>();
  const [busyMemberId, setBusyMemberId] = useState<string>();
  const [removing, setRemoving] = useState<Member>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const [loaded, emergency, uses, ruleBasics, events] = await Promise.all([
        loadMembers(medplum),
        medplum.searchOne('AccessPolicy', { name: EMERGENCY_POLICY_NAME }),
        medplum
          .search('AuditEvent', {
            type: `${CS_CARE}|break-glass`,
            subtype: `${CS_CARE}|activate`,
            _count: '1',
            _total: 'accurate',
          })
          .then((b) => b.total ?? 0)
          .catch(() => undefined),
        medplum.searchResources('Basic', { code: `${CS_CARE}|alert-rules`, _count: '50' }),
        medplum.searchResources('AuditEvent', {
          date: `ge${since.toISOString()}`,
          _sort: '-_lastUpdated',
          _count: '20',
        }),
      ]);
      setMembers(loaded);
      setEmergencyPolicy(emergency);
      setBreakGlassUses(uses);
      setAlertRules(ruleBasics.map(parseAlertRule));
      setAuditEvents(events);
      setExpandedId((current) => current ?? loaded[0]?.membership.id);
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

  // -- scope toggle: really rewrites the member's policy rules ---------------
  /**
   * Flip one scope for one member. Computes the next scope set in canonical
   * SCOPES order, rebuilds the policy resource[] (readonly rules + %patient
   * criteria — see rebuildPolicy), and PUTs the AccessPolicy. The knob is
   * optimistic and reverted on failure, so the UI never shows a share state
   * the server rejected. Retry-safe: the rebuild is a pure function of the
   * target scope set, so re-running converges on the same policy.
   */
  const toggleScope = async (member: Member, scopeKey: string): Promise<void> => {
    const memberId = member.membership.id as string;
    const turningOn = !member.scopes.includes(scopeKey);
    const nextScopes = SCOPES.map((s) => s.key).filter((k) =>
      k === scopeKey ? turningOn : member.scopes.includes(k)
    );
    const nextPolicy = rebuildPolicy(member.policy, nextScopes);
    const previous = member;

    // Optimistic knob; reverted on failure.
    setBusyMemberId(memberId);
    setMembers((ms) =>
      ms.map((m) => (m.membership.id === memberId ? { ...m, scopes: nextScopes, policy: nextPolicy } : m))
    );
    try {
      const saved = await medplum.updateResource(nextPolicy);
      setMembers((ms) =>
        ms.map((m) => (m.membership.id === memberId ? { ...m, scopes: nextScopes, policy: saved } : m))
      );
      const scopeLabel = SCOPES.find((s) => s.key === scopeKey)?.label ?? scopeKey;
      notifications.show({
        color: 'hmdGreen',
        message: `${scopeLabel} ${turningOn ? 'now shared with' : 'now hidden from'} ${firstName(member.name)}`,
      });
    } catch (err) {
      setMembers((ms) => ms.map((m) => (m.membership.id === memberId ? previous : m)));
      notifications.show({
        color: 'hmdRed',
        title: 'Could not change sharing',
        message: normalizeErrorString(err),
      });
    } finally {
      setBusyMemberId(undefined);
    }
  };

  // -- revoke: delete the membership (policy kept for the record) ------------
  /**
   * End a member's access entirely: deleting the ProjectMembership severs the
   * sign-in→policy binding, which is the whole enforcement path — the
   * AccessPolicy resource itself is intentionally left behind as a record of
   * what was shared. Time-boxed clinician shares also clean up their expiry
   * marker Basic (best-effort; access is already gone if that fails).
   */
  const confirmRemove = async (): Promise<void> => {
    if (!removing) return;
    const member = removing;
    setRemoveBusy(true);
    try {
      await medplum.deleteResource('ProjectMembership', member.membership.id as string);
      // Time-boxed shares carry an expiry marker; clean it up like the CLI does.
      if (member.expires) {
        try {
          const basics = await medplum.searchResources('Basic', {
            identifier: `${IDENT}/basic|share-expiry-${member.email}`,
            _count: '5',
          });
          await Promise.all(basics.map((b) => medplum.deleteResource('Basic', b.id as string)));
        } catch {
          // marker cleanup is best-effort; access itself is already gone
        }
      }
      setMembers((ms) => ms.filter((m) => m.membership.id !== member.membership.id));
      setRemoving(undefined);
      notifications.show({ color: 'hmdGreen', message: `${firstName(member.name)} no longer sees anything` });
    } catch (err) {
      notifications.show({
        color: 'hmdRed',
        title: 'Could not end access',
        message: normalizeErrorString(err),
      });
    } finally {
      setRemoveBusy(false);
    }
  };

  // -- who looked, lately -----------------------------------------------------
  const ownerRef = profile ? `${profile.resourceType}/${profile.id}` : undefined;
  const nameByRef = useMemo(() => new Map(members.map((m) => [m.profileRef, m.name])), [members]);
  const lookRows = useMemo(() => {
    const rows: { key: string; who: string; what: string; when: string }[] = [];
    for (const event of auditEvents) {
      // People and services only — bot plumbing is not "someone looking".
      const agent = event.agent?.find((a) => {
        const ref = a.who?.reference;
        if (!ref || ref === ownerRef) return false;
        return ref.split('/')[0] in AGENT_FALLBACK;
      });
      const ref = agent?.who?.reference;
      if (!ref) continue;
      rows.push({
        key: event.id as string,
        who: nameByRef.get(ref) ?? agent?.who?.display ?? AGENT_FALLBACK[ref.split('/')[0]] ?? 'someone',
        what: auditWhat(event),
        when: fmtWhen(event.recorded),
      });
    }
    return rows;
  }, [auditEvents, ownerRef, nameByRef]);

  if (loading) {
    return <Loader color="hmdGreen" />;
  }
  if (error) {
    return (
      <DsCard gap={6}>
        <CardTitle>Could not load sharing settings</CardTitle>
        <span style={mono(11.5, 400, T.outOfRange)}>{error}</span>
      </DsCard>
    );
  }

  const expanded = members.find((m) => m.membership.id === expandedId);
  const collapsed = members.filter((m) => m.membership.id !== expandedId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Who sees my health"
        subtitle="You decide what each person sees — change your mind anytime, and they simply stop seeing it."
        right={
          <PillButton variant="primary" onClick={() => setAddOpen(true)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <IconPlus size={15} stroke={1.7} style={{ marginTop: -1 }} />
              Add someone
            </span>
          </PillButton>
        }
      />

      {members.length === 0 ? (
        <DsCard padding={28} gap={10}>
          <CardTitle>Nobody else can see your health data</CardTitle>
          <span style={{ fontSize: 13, color: T.secondary, lineHeight: 1.6, maxWidth: 640 }}>
            Sharing is off until you invite someone. Each person gets only the areas you choose, always
            read-only, and you can end it the moment you change your mind. Inviting happens from the command
            line for now, so nothing in this app can quietly widen access.
          </span>
          <MonoHint>python scripts/care_circle.py add-caretaker --email … (--dry-run to preview)</MonoHint>
        </DsCard>
      ) : (
        <>
          {expanded ? (
            <ExpandedMemberCard
              member={expanded}
              busy={busyMemberId === expanded.membership.id}
              onToggle={(scopeKey) => toggleScope(expanded, scopeKey)}
              onCollapse={() => setExpandedId(undefined)}
              onRemove={() => setRemoving(expanded)}
            />
          ) : null}
          {collapsed.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {collapsed.map((member) => (
                <CollapsedMemberCard
                  key={member.membership.id}
                  member={member}
                  onExpand={() => setExpandedId(member.membership.id)}
                />
              ))}
            </div>
          ) : null}
        </>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 16, alignItems: 'start' }}>
        <AlertRulesCard rules={alertRules} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <EmergencyCard policy={emergencyPolicy} uses={breakGlassUses} />
          <DsCard padding="16px 20px" gap={9}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <IconHistory size={15} stroke={1.7} color={T.tertiary} />
              <CardTitle size={14}>Who looked, lately</CardTitle>
              <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>last 30 days</span>
            </div>
            {lookRows.length === 0 ? (
              <span style={mono(11, 400, T.quaternary)}>nothing to show — no one but you</span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {lookRows.map((row) => (
                  <div key={row.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span style={mono(11, 400, T.tertiary)}>
                      {row.who} · {row.what}
                    </span>
                    <span style={{ ...mono(11, 400, T.ink), whiteSpace: 'nowrap' }}>{row.when}</span>
                  </div>
                ))}
              </div>
            )}
          </DsCard>
        </div>
      </div>

      {/* -- add someone (CLI, on purpose) ---------------------------------- */}
      <Modal opened={addOpen} onClose={() => setAddOpen(false)} radius="lg" centered withCloseButton={false} padding={24}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <CardTitle size={16}>Add someone to your care circle</CardTitle>
          <span style={{ fontSize: 13, color: T.secondary, lineHeight: 1.6 }}>
            Inviting someone creates their sign-in and their read-only view, so it happens from the command
            line for now — nothing in this app can quietly widen access. Once they exist, their card appears
            here and every toggle works immediately.
          </span>
          <MonoHint>
            python scripts/care_circle.py add-caretaker --email name@example.com --first First --last Last
            <br />
            python scripts/care_circle.py add-clinician-share --email dr@example.com --first First --last Last
            --days 30
            <br />
            (--dry-run to preview)
          </MonoHint>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <PillButton variant="secondary" onClick={() => setAddOpen(false)}>
              Got it
            </PillButton>
          </div>
        </div>
      </Modal>

      {/* -- confirm revoke -------------------------------------------------- */}
      <Modal
        opened={removing !== undefined}
        onClose={() => (removeBusy ? undefined : setRemoving(undefined))}
        radius="lg"
        centered
        withCloseButton={false}
        padding={24}
      >
        {removing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <CardTitle size={16}>End {firstName(removing.name)}&rsquo;s access?</CardTitle>
            <span style={{ fontSize: 13, color: T.secondary, lineHeight: 1.6 }}>
              They stop seeing everything the moment you confirm — their view simply goes dark. Nothing in
              your record changes, and you can invite them back anytime.
            </span>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <PillButton variant="ghost" onClick={() => setRemoving(undefined)} disabled={removeBusy}>
                Keep sharing
              </PillButton>
              <PillButton variant="destructive" onClick={confirmRemove} disabled={removeBusy}>
                End access now
              </PillButton>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Member cards
// ---------------------------------------------------------------------------

/** Full member card: identity header (role pill, expiry chip for time-boxed
 * shares), one toggle per SCOPES entry (all disabled while a write is in
 * flight — one policy PUT at a time), and the revoke affordance. */
function ExpandedMemberCard({
  member,
  busy,
  onToggle,
  onCollapse,
  onRemove,
}: {
  member: Member;
  busy: boolean;
  onToggle: (scopeKey: string) => void;
  onCollapse: () => void;
  onRemove: () => void;
}) {
  const shared = member.scopes.length;
  const expiry = member.expires ? expiryLabel(member.expires) : undefined;
  return (
    <DsCard
      flush
      gap={0}
      style={{
        borderRadius: 20,
        // design-spec expanded-card outline (Web - Access Control) — soft green
        border: '1.5px solid #cfe5dc',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '20px 26px 14px' }}>
        <Avatar name={member.name} role={member.role} size={44} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-.015em' }}>{member.name}</span>
            <RolePill role={member.role} />
          </span>
          <span style={mono(11, 400, T.tertiary)}>{member.email} · read-only</span>
        </div>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {expiry ? (
            <span
              style={{
                ...mono(10.5, 500, expiry.color),
                background: T.band,
                borderRadius: 20,
                padding: '4px 10px',
                whiteSpace: 'nowrap',
              }}
            >
              {expiry.text}
            </span>
          ) : null}
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <StatusDot color={T.inRange} size={7} />
            <span style={mono(10.5, 500, T.inRange)}>ACTIVE</span>
          </span>
          <LinkButton onClick={onCollapse}>Done</LinkButton>
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 26px', padding: '6px 26px 8px' }}>
        {SCOPES.map((scope) => {
          const on = member.scopes.includes(scope.key);
          return (
            <div
              key={scope.key}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 14,
                alignItems: 'center',
                padding: '12px 0',
                borderTop: `1px solid ${T.band}`,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    letterSpacing: '-.01em',
                    color: on ? T.ink : T.tertiary,
                  }}
                >
                  {scope.label}
                </span>
                <span style={mono(10, 400, T.quaternary)}>{scope.detail}</span>
              </div>
              <ToggleSwitch
                on={on}
                disabled={busy}
                label={`${scope.label} — ${on ? 'shared' : 'private'}`}
                onToggle={() => onToggle(scope.key)}
              />
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 26px',
          background: T.cardFooter,
          borderTop: `1px solid ${T.band}`,
        }}
      >
        <span style={mono(11, 400, T.tertiary)}>
          {shared} of {SCOPES.length} areas shared · everything else stays private
        </span>
        <PillButton variant="destructive-tint" onClick={onRemove} style={{ marginLeft: 'auto' }} size={12.5}>
          Remove {firstName(member.name)}&rsquo;s access
        </PillButton>
      </div>
    </DsCard>
  );
}

function CollapsedMemberCard({ member, onExpand }: { member: Member; onExpand: () => void }) {
  const expiry = member.expires ? expiryLabel(member.expires) : undefined;
  return (
    <DsCard padding="18px 22px" gap={0} style={{ flexDirection: 'row', alignItems: 'center', gap: 13 } as CSSProperties}>
      <Avatar name={member.name} role={member.role} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span
            style={{
              fontSize: 14.5,
              fontWeight: 600,
              letterSpacing: '-.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {member.name}
          </span>
          <RolePill role={member.role} />
        </span>
        <span style={mono(10, 400, T.tertiary)}>
          {member.scopes.length} of {SCOPES.length} areas · read-only
          {expiry ? (
            <>
              {' · '}
              <span style={{ color: expiry.color }}>{expiry.text}</span>
            </>
          ) : null}
        </span>
      </div>
      <span style={{ marginLeft: 'auto' }}>
        <LinkButton onClick={onExpand}>Change</LinkButton>
      </span>
    </DsCard>
  );
}

// ---------------------------------------------------------------------------
// Alert rules ("When to tell my family")
// ---------------------------------------------------------------------------

function AlertRulesCard({ rules }: { rules: AlertRule[] }) {
  return (
    <DsCard flush gap={0}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '18px 24px 10px' }}>
        <CardTitle>When to tell my family</CardTitle>
        <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>my rules, not theirs</span>
      </div>
      {rules.length === 0 ? (
        <div style={{ padding: '14px 24px 20px' }}>
          <span style={mono(11, 400, T.quaternary)}>
            no rules yet — nothing is sent to anyone automatically
          </span>
        </div>
      ) : (
        rules.map((rule) => (
          <div
            key={rule.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto auto',
              gap: 16,
              alignItems: 'center',
              padding: '13px 24px',
              borderTop: `1px solid ${T.band}`,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 500, letterSpacing: '-.01em' }}>{rule.rule}</span>
              {rule.detail ? <span style={mono(10, 400, T.quaternary)}>{rule.detail}</span> : null}
            </div>
            <span style={mono(11, 400, T.tertiary)}>{rule.who}</span>
            <span style={mono(10, 500, rule.enabled ? T.inRange : T.quaternary)}>
              {rule.enabled ? 'ON' : 'OFF, my choice'}
            </span>
          </div>
        ))
      )}
    </DsCard>
  );
}

// ---------------------------------------------------------------------------
// Emergency access ("If I can't respond") — display only; the switch lives in
// the back end (break-glass helper), so no fake toggle is rendered here.
// ---------------------------------------------------------------------------

function EmergencyCard({ policy, uses }: { policy?: AccessPolicy; uses?: number }) {
  return (
    <DsCard dark padding="18px 22px" gap={10}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconShieldCheck size={15} stroke={1.7} color={T.liveAccent} />
        <CardTitle size={14.5}>If I can&rsquo;t respond</CardTitle>
      </div>
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: '#98989d' }}>
        A caretaker can unlock your health data — read-only, never settings or keys — for 24 hours,
        after which access restores itself. You are told the moment it happens, and it is written into
        your record&rsquo;s history permanently, before any access is granted.
      </p>
      {policy ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusDot color={T.liveAccent} size={6} />
          <span style={mono(10.5, 500, '#d1d1d6')}>
            ENABLED · {uses === undefined ? 'use history unavailable' : uses === 0 ? 'never used' : `used ${uses}×`}
          </span>
        </div>
      ) : (
        <MonoHint dark>
          not set up yet — run: python scripts/deploy_bots.py (installs the break-glass helper)
        </MonoHint>
      )}
    </DsCard>
  );
}
