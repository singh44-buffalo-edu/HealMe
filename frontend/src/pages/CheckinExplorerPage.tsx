import { Loader } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import type { QuestionnaireResponse } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconChecklist, IconSearch } from '@tabler/icons-react';
import type { CSSProperties, JSX } from 'react';
import { useEffect, useState } from 'react';
import { DsCard, FilterChips, PageHeader, TableRow } from '../components/ds';
import { mono, T } from '../tokens';

// ---------------------------------------------------------------------------
// Presentation helpers (History Log week-grouped-rows pattern)
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-07-15T09:12:34+05:30" → "Jul 15 09:12" — string-derived, same clock
 *  time the old `.replace('T', ' ').slice(0, 16)` display showed (no tz shift). */
function formatWhen(authored: string | undefined): string {
  const s = authored ?? '';
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (s.length < 10 || !m || !d) {
    return '';
  }
  const time = s.length >= 16 ? ` ${s.slice(11, 16)}` : '';
  return `${MONTHS[m - 1]} ${d}${time}`;
}

/** Local Monday-of-week key ("2026-07-13") for a date. */
function mondayKey(date: Date): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Week key of an authored timestamp; '' when undated/unparseable. */
function weekOf(authored: string | undefined): string {
  const s = authored ?? '';
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (!y || !m || !d) {
    return '';
  }
  return mondayKey(new Date(y, m - 1, d));
}

/** Group divider label: This week / Last week / Week of Jul 6 [2025] / Undated. */
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
  const year = y === now.getFullYear() ? '' : ` ${y}`;
  return `Week of ${MONTHS[m - 1]} ${d}${year}`;
}

/** ".../Questionnaire/daily-check-in" → "daily-check-in" (real canonical tail). */
function questionnaireKey(url: string | undefined): string {
  return url?.split('/').pop() || 'check-in';
}

function humanize(slug: string): string {
  const s = slug.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Flatten one response's answers — identical extraction to the old table:
 *  answer[0], valueInteger ?? valueDecimal ?? valueString ?? valueBoolean,
 *  '—' when absent (checked with !== undefined so `false` renders "false"). */
function flattenAnswers(response: QuestionnaireResponse): { linkId: string; display: string }[] {
  const answers = new Map(
    response.item?.map((item) => {
      const a = item.answer?.[0];
      const value = a?.valueInteger ?? a?.valueDecimal ?? a?.valueString ?? a?.valueBoolean;
      return [item.linkId, value] as const;
    }) ?? []
  );
  return [...answers.entries()]
    .filter((entry): entry is [string, number | string | boolean | undefined] => Boolean(entry[0]))
    .map(([linkId, value]) => ({
      linkId,
      display: value !== undefined ? String(value) : '—',
    }));
}

interface LogRowModel {
  id: string;
  slug: string;
  title: string;
  when: string;
  weekKey: string;
  items: { linkId: string; display: string }[];
  meta: string;
  haystack: string;
}

// ---------------------------------------------------------------------------
// Local DS pieces (History Log spec §3.1)
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

function TextAction({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 'none',
        background: 'transparent',
        padding: 0,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 11.5,
        fontWeight: 500,
        color: T.green,
      }}
    >
      {label}
    </button>
  );
}

function LogRow({
  row,
  open,
  first,
  onToggle,
}: {
  row: LogRowModel;
  open: boolean;
  first: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <TableRow first={first} padding="13px 18px">
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 13, alignItems: 'center' }}>
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              background: T.band,
              color: T.ink,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <IconChecklist size={15} stroke={1.7} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ ...mono(10, 400, T.quaternary), whiteSpace: 'nowrap' }}>{row.when}</span>
            <TextAction label={open ? 'Hide' : 'View'} onClick={onToggle} />
          </div>
        </div>
        {open ? (
          <div
            style={{
              marginTop: 11,
              paddingTop: 11,
              borderTop: `1px solid ${T.band}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
            }}
          >
            {row.items.length === 0 ? (
              <span style={mono(10.5, 400, T.quaternary)}>no answers recorded</span>
            ) : (
              row.items.map((it) => (
                <div key={it.linkId} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span style={mono(10.5, 400, T.tertiary)}>{it.linkId}</span>
                  <span style={mono(10.5, 400, T.ink)}>{it.display}</span>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Question-response explorer: every check-in, newest first, answers flattened. */
export function CheckinExplorerPage(): JSX.Element {
  const medplum = useMedplum();
  const [responses, setResponses] = useState<QuestionnaireResponse[]>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    medplum
      .searchResources('QuestionnaireResponse', { _sort: '-authored', _count: '100' })
      .then((r) => setResponses([...r]))
      .catch((err) => setError(normalizeErrorString(err)));
  }, [medplum]);

  const pageRoot: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 20 };

  if (error) {
    return (
      <div style={pageRoot}>
        <PageHeader title="Check-in explorer" subtitle="every check-in you have submitted, newest first" />
        <DsCard gap={6}>
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-.01em', color: T.outOfRange }}>
            Could not load check-ins
          </span>
          <span style={mono(11, 400, T.tertiary)}>{error}</span>
        </DsCard>
      </div>
    );
  }
  if (!responses) {
    return (
      <div style={pageRoot}>
        <PageHeader title="Check-in explorer" subtitle="every check-in you have submitted, newest first" />
        <DsCard padding={36} style={{ alignItems: 'center' }}>
          <Loader size="sm" color={T.green} />
        </DsCard>
      </div>
    );
  }

  const rows: LogRowModel[] = responses.map((response, index) => {
    const slug = questionnaireKey(response.questionnaire);
    const items = flattenAnswers(response);
    const when = formatWhen(response.authored);
    const meta = items.length > 0 ? items.map((it) => `${it.linkId} ${it.display}`).join(' · ') : 'no answers recorded';
    const title = humanize(slug);
    return {
      id: response.id ?? `row-${index}`,
      slug,
      title,
      when,
      weekKey: weekOf(response.authored),
      items,
      meta,
      haystack: `${title} ${slug} ${when} ${meta}`.toLowerCase(),
    };
  });

  const slugs = [...new Set(rows.map((r) => r.slug))];
  const chips = [
    { value: 'all', label: 'All', count: rows.length.toLocaleString('en-US') },
    ...slugs.map((s) => ({
      value: `q:${s}`,
      label: humanize(s),
      count: rows.filter((r) => r.slug === s).length.toLocaleString('en-US'),
    })),
  ];

  const q = query.trim().toLowerCase();
  const filtered = rows.filter(
    (r) => (filter === 'all' || filter === `q:${r.slug}`) && (q === '' || r.haystack.includes(q))
  );

  const groups: { key: string; label: string; rows: LogRowModel[] }[] = [];
  for (const row of filtered) {
    const last = groups[groups.length - 1];
    if (last && last.key === row.weekKey) {
      last.rows.push(row);
    } else {
      groups.push({ key: row.weekKey, label: weekLabel(row.weekKey), rows: [row] });
    }
  }

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div style={pageRoot}>
      <style>{'.hmd-checkins-search::placeholder{color:#aeaeb2}'}</style>
      <PageHeader
        title="Check-in explorer"
        subtitle={`every check-in you have submitted, newest first · ${responses.length} shown`}
        right={
          responses.length > 0 ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: T.card,
                borderRadius: 20,
                padding: '9px 16px',
                width: 260,
                boxSizing: 'border-box',
                boxShadow: '0 1px 2px rgba(0,0,0,.04)',
              }}
            >
              <IconSearch size={13} stroke={1.7} color={T.quaternary} style={{ flexShrink: 0 }} />
              <input
                className="hmd-checkins-search"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="Search check-ins…"
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
      {responses.length === 0 ? (
        <DsCard padding="28px 22px">
          <span style={mono(11, 400, T.quaternary)}>
            No check-ins yet — do your first one under Daily check-in.
          </span>
        </DsCard>
      ) : (
        <>
          <FilterChips options={chips} value={filter} onChange={setFilter} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {filtered.length === 0 ? (
              <DsCard padding="28px 22px">
                <span style={mono(11, 400, T.quaternary)}>no check-ins match this filter</span>
              </DsCard>
            ) : (
              groups.map((group, gi) => (
                <div key={`${group.key}-${gi}`} style={{ display: 'flex', flexDirection: 'column' }}>
                  <GroupDivider label={group.label} />
                  <DsCard flush gap={0}>
                    {group.rows.map((row, ri) => (
                      <LogRow
                        key={row.id}
                        row={row}
                        first={ri === 0}
                        open={expanded.has(row.id)}
                        onToggle={() => toggle(row.id)}
                      />
                    ))}
                  </DsCard>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
