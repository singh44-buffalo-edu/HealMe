/**
 * CheckinPage — the cadence-driven check-in surface ("Check-ins" nav item).
 *
 * Architecture: routed from App.tsx; all data access goes through the shared
 * helpers in ../fhir (loadCheckins / getPatient), which hit the Medplum CDR
 * directly via MedplumClient. Rendering the actual form is delegated to
 * @medplum/react's <QuestionnaireForm>.
 *
 * Cadence engine (FHIR-MAPPING.md §2 "Questionnaire cadence", spec §11-lite):
 * - Every active Questionnaire tagged with the questionnaire-cadence extension
 *   (valueCode D|W|M) is a check-in. loadCheckins() computes the current
 *   period identifier per cadence — `{q-key}-{YYYY-MM-DD}` (daily),
 *   `{q-key}-week-{monday}` (weekly), `{q-key}-month-{YYYY-MM}` (monthly) —
 *   and looks up whether a QuestionnaireResponse already exists for it.
 * - "DUE" simply means: no response with this period identifier yet. There is
 *   no separate due-table or cron — dueness is derived, never stored.
 * - Resubmitting inside the same period UPDATES the existing response (same
 *   identifier) rather than creating a duplicate. That identifier is the
 *   idempotency key (FHIR-MAPPING.md §7 "Daily response").
 *
 * Downstream: a Subscription-triggered Bot fans selected answers out to
 * Observations (derivedFrom → this response). This page never writes
 * Observations itself — QuestionnaireResponse is the source of truth
 * (FHIR-MAPPING.md §4). Note the Bot fires on create/update but derived
 * Observations chart the first submission until re-derivation lands (the
 * notification below says so to the user).
 */
import { Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { QuestionnaireResponse } from '@medplum/fhirtypes';
import { QuestionnaireForm, useMedplum } from '@medplum/react';
import { IconPencil } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { DsCard, Eyebrow, PageHeader, PillButton, StatusDot } from '../components/ds';
import type { CheckinDef } from '../fhir';
import { CADENCE_LABEL, QR_IDENT_SYSTEM, getPatient, loadCheckins } from '../fhir';
import { T, mono } from '../tokens';

/** Mono state word + status dot: DUE (watch amber) / DONE (in-range green). */
function StateTag({ due }: { due: boolean }) {
  const color = due ? T.watch : T.inRange;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <StatusDot color={color} size={6} />
      <span style={{ ...mono(9.5, 500, color), letterSpacing: '.06em' }}>{due ? 'DUE' : 'DONE'}</span>
    </span>
  );
}

/** Selector tile — DS tile language (1px chip border, r16; selected = green border + tinted shadow). */
function CheckinTile({
  def,
  selected,
  onSelect,
}: {
  def: CheckinDef;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{
        background: T.card,
        border: `1px solid ${selected ? T.green : T.chip}`,
        borderRadius: 16,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        cursor: 'pointer',
        boxShadow: selected ? '0 4px 16px rgba(15,138,99,.10)' : undefined,
      }}
    >
      <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-.01em', color: T.ink }}>
        {def.questionnaire.title}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={mono(10, 400, T.tertiary)}>{CADENCE_LABEL[def.cadence].toLowerCase()}</span>
        <span style={{ marginLeft: 'auto' }}>
          <StateTag due={!def.existing} />
        </span>
      </span>
    </div>
  );
}

/**
 * Check-in hub: tile per cadence-tagged questionnaire, DUE/DONE state, and the
 * selected form (or its submitted answers with an Edit affordance).
 *
 * FHIR touched: reads Questionnaire + QuestionnaireResponse (via loadCheckins),
 * reads Patient (subject ref), creates/updates one QuestionnaireResponse per
 * submit. Failure modes: load errors render the error card (page stays
 * usable on retry); save errors surface as a red notification and keep the
 * form state so nothing typed is lost.
 */
export function CheckinPage() {
  const medplum = useMedplum();
  const [checkins, setCheckins] = useState<CheckinDef[]>();
  const [selectedUrl, setSelectedUrl] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  // Re-entrancy guard: a double-click (or Enter-then-click) must not fire two
  // submits before reload() flips def.existing — that would POST two responses
  // for the same period. Paired with a conditional create for defense in depth.
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(async () => {
    try {
      const defs = await loadCheckins(medplum);
      setCheckins(defs);
      setError(undefined);
      // Auto-select the first due check-in
      setSelectedUrl((current) => current ?? defs.find((d) => !d.existing)?.questionnaire.url ?? defs[0]?.questionnaire.url);
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  }, [medplum]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <PageHeader title="Check-ins" subtitle="daily · weekly · monthly" />
        <DsCard style={{ maxWidth: 720 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <StatusDot color={T.outOfRange} size={7} />
            <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-.01em' }}>
              Could not load check-ins
            </span>
          </span>
          <span style={mono(11, 400, T.secondary)}>{error}</span>
        </DsCard>
      </div>
    );
  }
  if (!checkins) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <PageHeader title="Check-ins" subtitle="daily · weekly · monthly" />
        <DsCard padding={28} style={{ maxWidth: 720, alignItems: 'center' }}>
          <Loader size="sm" color="hmdGreen" />
        </DsCard>
      </div>
    );
  }
  if (checkins.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <PageHeader title="Check-ins" subtitle="daily · weekly · monthly" />
        <DsCard padding={28} style={{ maxWidth: 720 }}>
          <span style={mono(12, 400, T.quaternary)}>
            No check-in questionnaires found — run make seed to create them.
          </span>
        </DsCard>
      </div>
    );
  }

  const selected = checkins.find((d) => d.questionnaire.url === selectedUrl) ?? checkins[0];
  const dueCount = checkins.filter((d) => !d.existing).length;

  /**
   * Persist one check-in. The QuestionnaireForm hands us a draft response;
   * we stamp the fields the Bot and the period-dedup logic depend on:
   * canonical questionnaire url, Patient subject, authored = now (clinical
   * time; record time stays in meta.lastUpdated), and the stable period
   * identifier so a resubmit in the same period is an update, not a
   * duplicate (idempotent by construction — safe to retry after a failure).
   */
  const handleSubmit = async (def: CheckinDef, response: QuestionnaireResponse) => {
    if (submitting) return; // ignore repeat clicks while the first save is in flight
    setSubmitting(true);
    try {
      const patient = await getPatient(medplum);
      if (!patient) throw new Error('No patient record — run make seed');
      const resource: QuestionnaireResponse = {
        ...response,
        status: 'completed',
        questionnaire: def.questionnaire.url,
        subject: { reference: `Patient/${patient.id}` },
        authored: new Date().toISOString(),
        identifier: { system: QR_IDENT_SYSTEM, value: def.periodIdent },
      };
      if (def.existing) {
        // Same period ⇒ update the existing response in place (same id).
        await medplum.updateResource({ ...resource, id: def.existing.id });
        notifications.show({
          color: 'teal',
          message: `${def.questionnaire.title} updated. (Charted values keep the first submission until re-derivation lands.)`,
        });
      } else {
        // Conditional create on the period identifier: if a response for this
        // period already exists (e.g. a racing double-submit), the server
        // returns it instead of creating a duplicate.
        await medplum.createResourceIfNoneExist(resource, `identifier=${QR_IDENT_SYSTEM}|${def.periodIdent}`);
        notifications.show({ color: 'teal', message: `${def.questionnaire.title} saved — thank you!` });
      }
      setEditing(false);
      await reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save check-in', message: normalizeErrorString(err) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Check-ins"
        subtitle={`${checkins.length} check-ins · ${dueCount} due · daily / weekly / monthly`}
        right={
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              background: T.card,
              borderRadius: 20,
              padding: '6px 14px',
              boxShadow: T.shadowCard,
            }}
          >
            <StatusDot color={dueCount ? T.watch : T.inRange} size={7} />
            <span style={{ ...mono(10.5, 500, dueCount ? T.watch : T.inRange), letterSpacing: '.06em' }}>
              {dueCount ? `${dueCount} DUE` : 'ALL DONE'}
            </span>
          </span>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
          gap: 12,
        }}
      >
        {checkins.map((def) => (
          <CheckinTile
            key={def.questionnaire.url}
            def={def}
            selected={def.questionnaire.url === selected.questionnaire.url}
            onSelect={() => {
              setSelectedUrl(def.questionnaire.url);
              setEditing(false);
            }}
          />
        ))}
      </div>

      {selected.existing && !editing ? (
        <DsCard padding={24} gap={14} style={{ maxWidth: 720 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <StatusDot color={T.inRange} size={7} />
              <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: '-.01em' }}>
                {selected.questionnaire.title} — done for this{' '}
                {CADENCE_LABEL[selected.cadence].toLowerCase()} period
              </span>
            </span>
            <span style={{ ...mono(10.5, 400, T.tertiary), paddingLeft: 16 }}>
              Submitted {(selected.existing.authored ?? '').replace('T', ' ').slice(0, 16)}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ paddingBottom: 8 }}>
              <Eyebrow color={T.quaternary}>Answers</Eyebrow>
            </div>
            {selected.existing.item?.map((item) => {
              const a = item.answer?.[0];
              const value = a?.valueInteger ?? a?.valueDecimal ?? a?.valueString;
              return value !== undefined && value !== '' ? (
                <div
                  key={item.linkId}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 14,
                    padding: '9px 0',
                    borderTop: `1px solid ${T.band}`,
                  }}
                >
                  <span style={{ ...mono(10.5, 400, T.quaternary), minWidth: 160 }}>{item.linkId}</span>
                  <span
                    style={
                      typeof value === 'number'
                        ? mono(13, 500, T.ink)
                        : { fontSize: 13, color: T.ink }
                    }
                  >
                    {String(value)}
                  </span>
                </div>
              ) : null;
            })}
          </div>

          <PillButton variant="secondary" onClick={() => setEditing(true)} style={{ alignSelf: 'flex-start' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <IconPencil size={13} stroke={1.7} />
              Edit answers
            </span>
          </PillButton>
        </DsCard>
      ) : (
        <DsCard padding={24} gap={14} style={{ maxWidth: 720 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              paddingBottom: 12,
              borderBottom: `1px solid ${T.chip}`,
            }}
          >
            <Eyebrow color={T.quaternary}>{CADENCE_LABEL[selected.cadence]} check-in</Eyebrow>
            <span style={{ marginLeft: 'auto' }}>
              <StateTag due={!selected.existing} />
            </span>
          </div>
          {/*
           * Prefill on edit: questionnaireResponse feeds useQuestionnaireForm's
           * defaultValue, which merges the stored answers into the form items by
           * linkId — so "Edit answers" starts from what was submitted instead of a
           * blank form (a partial re-entry used to silently drop the untouched
           * answers from the record). The hook latches defaultValue on first mount
           * only, so the key encodes the prefill identity too: it still resets the
           * form when switching questionnaires, and additionally remounts when
           * toggling into edit mode so the prefill actually applies. The submitted
           * draft is rebuilt by the hook and never carries the stored response's
           * id/identifier — handleSubmit re-stamps the period identifier and (via
           * def.existing.id) the resource id, so the save stays an update of the
           * same logical response and _history versioning preserves prior answers.
           */}
          <QuestionnaireForm
            key={`${selected.questionnaire.url}#${editing ? (selected.existing?.id ?? 'edit') : 'new'}`}
            questionnaire={selected.questionnaire}
            questionnaireResponse={editing ? selected.existing : undefined}
            onSubmit={(response) => handleSubmit(selected, response)}
          />
        </DsCard>
      )}
    </div>
  );
}
