import { Alert, Badge, Button, Card, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { QuestionnaireResponse } from '@medplum/fhirtypes';
import { QuestionnaireForm, useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import type { CheckinDef } from '../fhir';
import { CADENCE_LABEL, QR_IDENT_SYSTEM, getPatient, loadCheckins } from '../fhir';

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
      <Alert color="red" title="Could not load check-ins">
        {error}
      </Alert>
    );
  }
  if (!checkins) return <Loader />;
  if (checkins.length === 0) {
    return (
      <Alert color="yellow" title="No check-in questionnaires found">
        Run <code>make seed</code> to create them.
      </Alert>
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
    <Stack maw={720}>
      <Group justify="space-between">
        <Title order={2}>Check-ins</Title>
        <Badge color={dueCount ? 'orange' : 'teal'} size="lg">
          {dueCount ? `${dueCount} due` : 'all done'}
        </Badge>
      </Group>

      <Group>
        {checkins.map((def) => (
          <Card
            key={def.questionnaire.url}
            withBorder
            padding="xs"
            style={{
              cursor: 'pointer',
              borderColor:
                def.questionnaire.url === selected.questionnaire.url ? 'var(--mantine-color-teal-6)' : undefined,
            }}
            onClick={() => {
              setSelectedUrl(def.questionnaire.url);
              setEditing(false);
            }}
          >
            <Group gap="xs">
              <Text fw={600} size="sm">
                {def.questionnaire.title}
              </Text>
              <Badge size="xs" variant="light">
                {CADENCE_LABEL[def.cadence]}
              </Badge>
              {def.existing ? <Badge size="xs" color="teal">done</Badge> : <Badge size="xs" color="orange">due</Badge>}
            </Group>
          </Card>
        ))}
      </Group>

      {selected.existing && !editing ? (
        <Card withBorder>
          <Stack>
            <Alert color="teal" title={`${selected.questionnaire.title} — done for this ${CADENCE_LABEL[selected.cadence].toLowerCase()} period`}>
              Submitted {(selected.existing.authored ?? '').replace('T', ' ').slice(0, 16)}.
            </Alert>
            {selected.existing.item?.map((item) => {
              const a = item.answer?.[0];
              const value = a?.valueInteger ?? a?.valueDecimal ?? a?.valueString;
              return value !== undefined && value !== '' ? (
                <Text key={item.linkId} size="sm">
                  <Text span c="dimmed">
                    {item.linkId}:
                  </Text>{' '}
                  {String(value)}
                </Text>
              ) : null;
            })}
            <Button variant="light" onClick={() => setEditing(true)}>
              Edit answers
            </Button>
          </Stack>
        </Card>
      ) : (
        <Card withBorder>
          <QuestionnaireForm
            key={selected.questionnaire.url}
            questionnaire={selected.questionnaire}
            onSubmit={(response) => handleSubmit(selected, response)}
          />
        </Card>
      )}
    </Stack>
  );
}
