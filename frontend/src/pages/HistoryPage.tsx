/**
 * HistoryPage — the transparency log ("nothing happens off the books"):
 * every sign-in, record change, automation run, and cloud AI request,
 * rendered in human words.
 *
 * Architecture: routed from App.tsx; a pure read-only projection over
 * Medplum AuditEvents (server-written for auth/CRUD/bots; ai-service-written
 * for the boundary ledger and assistant deletions). This page writes nothing
 * and classifies events entirely from their recorded shape — toRow() is
 * heuristic display logic, not a data model.
 *
 * The boundary ledger rows matter most (FHIR-MAPPING.md §11): the ai-service
 * writes one AuditEvent BEFORE every cloud AI call. Since 2026-07-15 those
 * events carry a machine-readable coding — AuditEvent.type
 * {BASE}/CodeSystem/audit|cloud-egress, subtype = the feature slug — which
 * toRow() matches first. Events written before the coding existed are still
 * recognized by their entity description "AI request · <feature> →
 * <provider> · …" (the legacy regex fallback — keep it until the historical
 * rows age out). Either way they render amber with the ☁ CLOUD tag — the
 * Privacy Vault promise that every byte leaving the machine is named here.
 *
 * Trust contract surfaced by RulesCard: edits create versions (FHIR history,
 * nothing lost), assistant-session deletion leaves a note, cloud calls are
 * always listed. Vocabulary rule: never show backend nouns — RESOURCE_WORD /
 * ENTITY-style words only.
 */
import { Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { AuditEvent } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import {
  IconCloudUpload,
  IconEraser,
  IconEye,
  IconHistory,
  IconLockOpen,
  IconLogin2,
  IconPencil,
  IconRobot,
  IconSearch,
  IconTrash,
  type Icon,
} from '@tabler/icons-react';
import type { CSSProperties, JSX } from 'react';
import { useEffect, useState } from 'react';
import { DsCard, FilterChips, PageHeader, PillButton, StatusDot } from '../components/ds';
import { BASE } from '../fhir';
import { mono, T } from '../tokens';

// Events per fetch. Medplum's _count default is 20 (max 1000); 100 keeps
// "Load earlier" clicks rare without hauling the whole log.
const PAGE_SIZE = 100;

// Local audit CodeSystem (FHIR-MAPPING §11). The ai-service stamps every
// cloud-boundary AuditEvent with type = CS_AUDIT|cloud-egress (subtype =
// feature slug) — written in ai-service/app/ai_settings.py; the two must
// stay in lockstep.
const CS_AUDIT = `${BASE}/CodeSystem/audit`;

// ---------------------------------------------------------------------------
// Time helpers — LOCAL clock (audit rows answer "when did this happen here")
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Jul 15 09:12" in local time. */
function formatWhen(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}

/** Local Monday-of-week key ("2026-07-13") for a date. */
function mondayKey(date: Date): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Group divider label: This week / Last week / "Jul 6 – Jul 12" date range. */
function weekLabel(weekKey: string): string {
  if (!weekKey) {
    return 'Undated';
  }
  const now = new Date();
  if (weekKey === mondayKey(now)) {
    return 'This week';
  }
  const prev = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  if (weekKey === mondayKey(prev)) {
    return 'Last week';
  }
  const [y, m, d] = weekKey.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 6);
  const range = `${MONTHS[start.getMonth()]} ${start.getDate()} – ${MONTHS[end.getMonth()]} ${end.getDate()}`;
  return y === now.getFullYear() ? range : `${range} ${y}`;
}

// ---------------------------------------------------------------------------
// Audit record → human row (no plumbing words on the surface)
// ---------------------------------------------------------------------------

type Category = 'ai' | 'access' | 'changes';

type RowKind =
  | 'cloud'
  | 'aiDeleted'
  | 'breakGlass'
  | 'auth'
  | 'view'
  | 'change'
  | 'remove'
  | 'bot'
  | 'other';

const TILE: Record<RowKind, { Icon: Icon; bg: string; fg: string }> = {
  cloud: { Icon: IconCloudUpload, bg: '#fdf9f1', fg: T.watch },
  aiDeleted: { Icon: IconTrash, bg: T.destructiveTint, fg: T.outOfRange },
  breakGlass: { Icon: IconLockOpen, bg: '#fbf6e4', fg: T.watch },
  auth: { Icon: IconLogin2, bg: T.band, fg: T.ink },
  view: { Icon: IconEye, bg: T.band, fg: T.ink },
  change: { Icon: IconPencil, bg: T.greenTint, fg: T.green },
  remove: { Icon: IconEraser, bg: T.destructiveTint, fg: T.outOfRange },
  bot: { Icon: IconRobot, bg: T.band, fg: T.ink },
  other: { Icon: IconHistory, bg: T.band, fg: T.ink },
};

interface RowModel {
  id: string;
  kind: RowKind;
  category: Category;
  title: string;
  meta: string;
  when: string;
  weekKey: string;
  /** cloud-boundary rows carry the amber "data left this device" dot */
  amberDot: boolean;
  tag?: { label: string; fg: string; bg: string };
  haystack: string;
  sortKey: number;
}

const PROVIDER_DISPLAY: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  google: 'Google',
  ollama: 'Ollama',
};

function providerDisplay(name: string): string {
  const key = name.trim().toLowerCase();
  return PROVIDER_DISPLAY[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'cloud provider');
}

/** Human word for what a record touched — never the backend type name. */
const RESOURCE_WORD: Record<string, string> = {
  Observation: 'Measurement',
  MedicationRequest: 'Medication plan',
  MedicationAdministration: 'Dose log',
  Medication: 'Medication',
  QuestionnaireResponse: 'Check-in',
  Questionnaire: 'Check-in form',
  DocumentReference: 'Document',
  Binary: 'File',
  Communication: 'Assistant session',
  Device: 'Cartridge',
  Task: 'Review item',
  Patient: 'Profile',
  Condition: 'Condition',
  SupplyDelivery: 'Refill',
  Provenance: 'Source note',
  DiagnosticReport: 'Lab report',
};

function resourceWord(reference: string | undefined): string {
  const type = reference?.split('/')[0] ?? '';
  return RESOURCE_WORD[type] ?? 'Record';
}

function agentName(event: AuditEvent): string {
  const agent = event.agent?.[0];
  return agent?.name ?? agent?.who?.display ?? '';
}

/**
 * Classify one AuditEvent into a display row. Precedence matters: boundary-
 * ledger coding (type CS_AUDIT|cloud-egress; legacy uncoded events matched
 * by their description string) → assistant deletion → break-glass → DICOM
 * auth code 110114 (Medplum uses the standard audit vocabulary: subtype
 * 110122 login / 110123 logout) → bot execution → plain REST interactions
 * (subtype read/create/update/delete or action C/R/U/D). Anything
 * unrecognized degrades to a generic "Activity recorded" row — unknown
 * events must still be visible, never dropped. outcome !== '0' marks failure.
 */
function toRow(event: AuditEvent, index: number): RowModel {
  const recorded = event.recorded ?? event.meta?.lastUpdated;
  const date = recorded ? new Date(recorded) : undefined;
  const valid = date !== undefined && !Number.isNaN(date.getTime());
  const when = valid ? formatWhen(date) : '';
  const weekKey = valid ? mondayKey(date) : '';
  const sortKey = valid ? date.getTime() : 0;

  const entity = event.entity?.[0];
  const desc = entity?.description ?? '';
  const agent = agentName(event);
  const typeCode = event.type?.code ?? '';
  const subtype = event.subtype?.[0]?.code ?? '';
  const failed = event.outcome !== undefined && event.outcome !== '0';

  let kind: RowKind = 'other';
  let category: Category = 'access';
  let title = 'Activity recorded';
  let metaParts: string[] = [];
  let amberDot = false;
  let tag: RowModel['tag'];

  // Cloud-boundary detection: the machine-readable coding is authoritative
  // (type CS_AUDIT|cloud-egress, subtype = feature slug); the description
  // regex remains only for historical events written before the coding.
  const cloudCoded = event.type?.system === CS_AUDIT && event.type?.code === 'cloud-egress';
  const boundary = desc.match(/^AI request · ([^·]+?) → ([^·]+?) ·/);
  if (cloudCoded || boundary) {
    // Cloud-boundary ledger entry — one per AI request whose data left this device.
    kind = 'cloud';
    category = 'ai';
    // Provider name still rides the human description line; the coding
    // identifies the event and the feature, not the provider.
    title = `Sent to ${providerDisplay(boundary?.[2] ?? '')} — cloud request`;
    amberDot = true;
    tag = { label: '☁ CLOUD', fg: T.watch, bg: '#fdf9f1' };
    const feature = cloudCoded ? subtype : (boundary?.[1] ?? '');
    metaParts = [entity?.name || feature, 'data left this device', agent];
  } else if (desc === 'assistant session deleted') {
    kind = 'aiDeleted';
    category = 'ai';
    title = 'Assistant session deleted';
    tag = { label: 'DELETED', fg: T.outOfRange, bg: T.destructiveTint };
    metaParts = ['questions and answers removed', 'this note remains', agent];
  } else if (typeCode === 'break-glass') {
    kind = 'breakGlass';
    category = 'access';
    title = subtype === 'restore' ? 'Emergency access ended' : 'Emergency access granted';
    tag = { label: 'EMERGENCY', fg: T.watch, bg: '#fbf6e4' };
    metaParts = [event.outcomeDesc ?? '', agent || (event.agent?.[0]?.who?.display ?? '')];
  } else if (typeCode === '110114') {
    // Sign-in / sign-out
    kind = 'auth';
    category = 'access';
    title = failed
      ? 'Sign-in failed'
      : subtype === '110123'
        ? 'Signed out'
        : subtype === '110122'
          ? 'Signed in'
          : 'Sign-in activity';
    metaParts = [agent, event.outcomeDesc ?? ''];
  } else if (
    typeCode === 'execute' ||
    event.source?.observer?.reference?.startsWith('Bot/') ||
    event.agent?.some((a) => a.type?.text === 'bot')
  ) {
    kind = 'bot';
    category = 'changes';
    title = failed ? 'Automation failed' : 'Automation ran';
    metaParts = [
      event.source?.observer?.display ?? agent,
      (event.outcomeDesc ?? '').slice(0, 120),
    ];
  } else {
    // Plain reads / writes from the record server.
    const word = resourceWord(entity?.what?.reference);
    const action = event.action ?? '';
    if (subtype.startsWith('search') || subtype === 'history-system') {
      kind = 'view';
      category = 'access';
      title = 'Records searched';
    } else if (subtype === 'read' || subtype === 'vread' || subtype.startsWith('history') || action === 'R') {
      kind = 'view';
      category = 'access';
      title = `${word} viewed`;
    } else if (subtype === 'create' || action === 'C') {
      kind = 'change';
      category = 'changes';
      title = `${word} added`;
    } else if (subtype === 'update' || subtype === 'patch' || action === 'U') {
      kind = 'change';
      category = 'changes';
      title = `${word} updated — earlier version kept`;
    } else if (subtype === 'delete' || action === 'D') {
      kind = 'remove';
      category = 'changes';
      title = `${word} removed`;
      tag = { label: 'DELETED', fg: T.outOfRange, bg: T.destructiveTint };
    } else {
      kind = 'other';
      category = 'access';
      title = entity?.name ?? 'Activity recorded';
      metaParts = [desc, event.outcomeDesc ?? ''];
    }
    if (metaParts.length === 0) {
      metaParts = [agent, entity?.name ?? '', event.outcomeDesc ?? ''];
    }
  }

  const meta = metaParts.map((p) => p.trim()).filter(Boolean).join(' · ') || 'no further detail recorded';
  return {
    id: event.id ?? `row-${index}`,
    kind,
    category,
    title,
    meta,
    when,
    weekKey,
    amberDot,
    tag,
    haystack: `${title} ${meta} ${when}`.toLowerCase(),
    sortKey,
  };
}

// ---------------------------------------------------------------------------
// Local DS pieces (History Log spec §3.1 / §3.2.3)
// ---------------------------------------------------------------------------

function GroupDivider({ label }: { label: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0 8px' }}>
      <span style={{ ...mono(11, 500, T.tertiary), letterSpacing: '.1em', textTransform: 'uppercase' }}>
        {label}
      </span>
      <span style={{ flex: 1, height: 1, background: '#e4e4e1' }} />
    </div>
  );
}

/** Mono class-tag pill (8.5px, r16) — per-kind fg/bg from the event palette. */
function ClassTag({ label, fg, bg }: { label: string; fg: string; bg: string }): JSX.Element {
  return (
    <span
      style={{
        ...mono(8.5, 500, fg),
        letterSpacing: '.06em',
        background: bg,
        borderRadius: 16,
        padding: '2px 7px',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

function LogRow({ row }: { row: RowModel }): JSX.Element {
  const tile = TILE[row.kind];
  return (
    <div
      style={{
        background: T.card,
        borderRadius: 14,
        padding: '13px 18px',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        gap: 13,
        alignItems: 'center',
        marginBottom: 8,
        boxShadow: '0 1px 2px rgba(0,0,0,.04), 0 6px 20px rgba(0,0,0,.04)',
      }}
    >
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: 10,
          background: tile.bg,
          color: tile.fg,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <tile.Icon size={15} stroke={1.7} />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {row.amberDot ? <StatusDot color={T.watch} size={6} /> : null}
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: '-.01em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {row.title}
          </span>
          {row.tag ? <ClassTag label={row.tag.label} fg={row.tag.fg} bg={row.tag.bg} /> : null}
        </div>
        <span
          style={{
            ...mono(10, 400, T.tertiary),
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {row.meta}
        </span>
      </div>
      <span style={{ ...mono(10, 400, T.quaternary), whiteSpace: 'nowrap' }}>{row.when}</span>
    </div>
  );
}

/** The product's edit/delete contract — persistent footnote card (spec §3.2.3). */
function RulesCard(): JSX.Element {
  const lines = [
    '· edits create new versions — nothing is lost',
    '· assistant sessions are deletable — an audit note remains',
    '· every cloud AI request lands here, named and timestamped',
  ];
  return (
    <div
      style={{
        background: T.cardFooter,
        borderRadius: 16,
        padding: '14px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      <span
        style={{
          ...mono(9.5, 500, T.quaternary),
          letterSpacing: '.12em',
          textTransform: 'uppercase',
        }}
      >
        How edits &amp; deletes work
      </span>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {lines.map((line) => (
          <span key={line} style={{ ...mono(11, 400, T.tertiary), lineHeight: 1.65 }}>
            {line}
          </span>
        ))}
      </div>
    </div>
  );
}

function QuietCard({ children }: { children: string }): JSX.Element {
  return (
    <DsCard padding="28px 22px">
      <span style={mono(11, 400, T.quaternary)}>{children}</span>
    </DsCard>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * History log: every sign-in, change, and AI request — nothing off the books.
 *
 * FHIR touched: reads AuditEvent only (newest first, PAGE_SIZE per page,
 * offset-paginated by "Load earlier" — note Medplum caps _offset at 10 000,
 * a practical ceiling this single-user log won't hit for years). Rows are
 * re-sorted client-side by recorded time because the fetch order is
 * -_lastUpdated (write time), which can differ slightly. Failure modes:
 * initial-load errors render the error card; pagination errors toast and
 * keep what's already shown. Dedup by event id guards overlapping pages
 * (new events shift offsets between clicks).
 */
export function HistoryPage(): JSX.Element {
  const medplum = useMedplum();
  const [events, setEvents] = useState<AuditEvent[]>();
  const [error, setError] = useState<string>();
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    medplum
      .searchResources('AuditEvent', { _sort: '-_lastUpdated', _count: String(PAGE_SIZE) })
      .then((page) => {
        setEvents([...page]);
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch((err) => setError(normalizeErrorString(err)));
  }, [medplum]);

  /** Fetch the next PAGE_SIZE events at _offset = current length; hasMore is
   * inferred from a full page coming back (no _total request needed). */
  const loadEarlier = (): void => {
    if (!events || loadingMore) {
      return;
    }
    setLoadingMore(true);
    medplum
      .searchResources('AuditEvent', {
        _sort: '-_lastUpdated',
        _count: String(PAGE_SIZE),
        _offset: String(events.length),
      })
      .then((page) => {
        setEvents((prev) => {
          const seen = new Set((prev ?? []).map((e) => e.id));
          return [...(prev ?? []), ...page.filter((e) => !seen.has(e.id))];
        });
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch((err) => {
        notifications.show({ color: 'hmdRed', message: normalizeErrorString(err) });
      })
      .finally(() => setLoadingMore(false));
  };

  const pageRoot: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 20 };
  const subtitle = 'every question asked, file uploaded, and value changed — nothing happens off the books';

  if (error) {
    return (
      <div style={pageRoot}>
        <PageHeader title="History" subtitle={subtitle} />
        <DsCard gap={6}>
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-.01em', color: T.outOfRange }}>
            Could not load the history log
          </span>
          <span style={mono(11, 400, T.tertiary)}>{error}</span>
        </DsCard>
      </div>
    );
  }
  if (!events) {
    return (
      <div style={pageRoot}>
        <PageHeader title="History" subtitle={subtitle} />
        <DsCard padding={36} style={{ alignItems: 'center' }}>
          <Loader size="sm" color={T.green} />
        </DsCard>
      </div>
    );
  }

  const rows = events.map(toRow).sort((a, b) => b.sortKey - a.sortKey);

  const countOf = (category?: Category): string =>
    (category === undefined ? rows : rows.filter((r) => r.category === category)).length.toLocaleString('en-US');
  const chips = [
    { value: 'all', label: 'All', count: countOf() },
    { value: 'ai', label: '✦ AI & cloud', count: countOf('ai'), ai: true },
    { value: 'access', label: 'Access', count: countOf('access') },
    { value: 'changes', label: 'Changes', count: countOf('changes') },
  ];

  const q = query.trim().toLowerCase();
  const filtered = rows.filter(
    (r) => (filter === 'all' || r.category === filter) && (q === '' || r.haystack.includes(q))
  );

  const groups: { key: string; label: string; rows: RowModel[] }[] = [];
  for (const row of filtered) {
    const last = groups[groups.length - 1];
    if (last && last.key === row.weekKey) {
      last.rows.push(row);
    } else {
      groups.push({ key: row.weekKey, label: weekLabel(row.weekKey), rows: [row] });
    }
  }

  return (
    <div style={pageRoot}>
      <style>{'.hmd-history-search::placeholder{color:#aeaeb2}'}</style>
      <PageHeader
        title="History"
        subtitle={subtitle}
        right={
          rows.length > 0 ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: T.card,
                borderRadius: 20,
                padding: '9px 16px',
                width: 240,
                boxSizing: 'border-box',
                boxShadow: '0 1px 2px rgba(0,0,0,.04)',
              }}
            >
              <IconSearch size={13} stroke={1.7} color={T.quaternary} style={{ flexShrink: 0 }} />
              <input
                className="hmd-history-search"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="Search history…"
                style={{
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  color: T.ink,
                  width: '100%',
                  padding: 0,
                }}
              />
            </div>
          ) : undefined
        }
      />
      {rows.length > 0 ? <FilterChips options={chips} value={filter} onChange={setFilter} /> : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.5fr 1fr',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0 }}>
          {rows.length === 0 ? (
            <QuietCard>
              Nothing here yet — sign-ins, edits and AI requests will appear as they happen.
            </QuietCard>
          ) : filtered.length === 0 ? (
            <QuietCard>no activity matches this filter</QuietCard>
          ) : (
            groups.map((group, gi) => (
              <div key={`${group.key}-${gi}`} style={{ display: 'flex', flexDirection: 'column' }}>
                <GroupDivider label={group.label} />
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {group.rows.map((row) => (
                    <LogRow key={row.id} row={row} />
                  ))}
                </div>
              </div>
            ))
          )}
          {hasMore ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 0' }}>
              <PillButton variant="secondary" size={12} onClick={loadEarlier} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load earlier'}
              </PillButton>
            </div>
          ) : null}
        </div>
        <div style={{ position: 'sticky', top: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <RulesCard />
        </div>
      </div>
    </div>
  );
}
