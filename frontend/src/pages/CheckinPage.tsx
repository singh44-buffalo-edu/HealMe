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

export function CheckinPage() {
  const medplum = useMedplum();
  const [checkins, setCheckins] = useState<CheckinDef[]>();
  const [selectedUrl, setSelectedUrl] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();

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

  const handleSubmit = async (def: CheckinDef, response: QuestionnaireResponse) => {
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
        await medplum.updateResource({ ...resource, id: def.existing.id });
        notifications.show({
          color: 'teal',
          message: `${def.questionnaire.title} updated. (Charted values keep the first submission until re-derivation lands.)`,
        });
      } else {
        await medplum.createResource(resource);
        notifications.show({ color: 'teal', message: `${def.questionnaire.title} saved — thank you!` });
      }
      setEditing(false);
      await reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save check-in', message: normalizeErrorString(err) });
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
          <QuestionnaireForm
            key={selected.questionnaire.url}
            questionnaire={selected.questionnaire}
            onSubmit={(response) => handleSubmit(selected, response)}
          />
        </DsCard>
      )}
    </div>
  );
}
