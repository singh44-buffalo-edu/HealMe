import { Alert, Button, Card, Loader, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes';
import { QuestionnaireForm, useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import { IDENT, Q_URL, getPatient, localDateString } from '../fhir';

const QR_IDENT_SYSTEM = `${IDENT}/questionnaire-response`;

export function CheckinPage() {
  const medplum = useMedplum();
  const [questionnaire, setQuestionnaire] = useState<Questionnaire>();
  const [existing, setExisting] = useState<QuestionnaireResponse>();
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const today = localDateString(new Date());
  const identValue = `daily-${today}`;

  const reload = useCallback(async () => {
    try {
      const [q, existingResponse] = await Promise.all([
        medplum.searchOne('Questionnaire', { url: Q_URL }),
        medplum.searchOne('QuestionnaireResponse', {
          identifier: `${QR_IDENT_SYSTEM}|${identValue}`,
        }),
      ]);
      setQuestionnaire(q);
      setExisting(existingResponse);
      setError(undefined);
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setLoading(false);
    }
  }, [medplum, identValue]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleSubmit = async (response: QuestionnaireResponse) => {
    try {
      const patient = await getPatient(medplum);
      if (!patient) {
        throw new Error('No patient record — run make seed');
      }
      const resource: QuestionnaireResponse = {
        ...response,
        status: 'completed',
        questionnaire: Q_URL,
        subject: { reference: `Patient/${patient.id}` },
        authored: new Date().toISOString(),
        identifier: { system: QR_IDENT_SYSTEM, value: identValue },
      };
      if (existing) {
        await medplum.updateResource({ ...resource, id: existing.id });
        notifications.show({
          color: 'teal',
          message:
            "Today's check-in updated. (Charted values keep the first submission until the question engine phase.)",
        });
      } else {
        await medplum.createResource(resource);
        notifications.show({ color: 'teal', message: 'Check-in saved — thank you!' });
      }
      setEditing(false);
      await reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save check-in', message: normalizeErrorString(err) });
    }
  };

  if (loading) return <Loader />;
  if (error) {
    return (
      <Alert color="red" title="Could not load the check-in">
        {error}
      </Alert>
    );
  }
  if (!questionnaire) {
    return (
      <Alert color="yellow" title="No check-in questionnaire found">
        Run <code>make seed</code> to create the daily check-in.
      </Alert>
    );
  }

  return (
    <Stack maw={640}>
      <Title order={2}>Daily check-in</Title>
      {existing && !editing ? (
        <Card withBorder>
          <Stack>
            <Alert color="teal" title="Done for today">
              You checked in at {(existing.authored ?? '').replace('T', ' ').slice(0, 16)}.
            </Alert>
            {existing.item?.map((item) => {
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
              Edit today's answers
            </Button>
          </Stack>
        </Card>
      ) : (
        <Card withBorder>
          <QuestionnaireForm questionnaire={questionnaire} onSubmit={handleSubmit} />
        </Card>
      )}
    </Stack>
  );
}
