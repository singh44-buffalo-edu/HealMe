import { Alert, Card, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import type { QuestionnaireResponse } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useEffect, useState } from 'react';

/** Question-response explorer: every check-in, newest first, answers flattened. */
export function CheckinExplorerPage() {
  const medplum = useMedplum();
  const [responses, setResponses] = useState<QuestionnaireResponse[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    medplum
      .searchResources('QuestionnaireResponse', { _sort: '-authored', _count: '100' })
      .then((r) => setResponses([...r]))
      .catch((err) => setError(normalizeErrorString(err)));
  }, [medplum]);

  if (error) {
    return (
      <Alert color="red" title="Could not load check-ins">
        {error}
      </Alert>
    );
  }
  if (!responses) return <Loader />;

  const linkIds = [...new Set(responses.flatMap((r) => r.item?.map((i) => i.linkId ?? '') ?? []))].filter(
    Boolean
  );

  return (
    <Stack>
      <Title order={2}>Check-in explorer</Title>
      <Text c="dimmed" size="sm">
        Every check-in you have submitted, newest first ({responses.length} shown).
      </Text>
      {responses.length === 0 ? (
        <Text c="dimmed">No check-ins yet — do your first one under Daily check-in.</Text>
      ) : (
        <Card withBorder style={{ overflowX: 'auto' }}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Submitted</Table.Th>
                {linkIds.map((id) => (
                  <Table.Th key={id}>{id}</Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {responses.map((response) => {
                const answers = new Map(
                  response.item?.map((item) => {
                    const a = item.answer?.[0];
                    const value = a?.valueInteger ?? a?.valueDecimal ?? a?.valueString ?? a?.valueBoolean;
                    return [item.linkId, value] as const;
                  }) ?? []
                );
                return (
                  <Table.Tr key={response.id}>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>
                      {(response.authored ?? '').replace('T', ' ').slice(0, 16)}
                    </Table.Td>
                    {linkIds.map((id) => (
                      <Table.Td key={id}>{answers.get(id) !== undefined ? String(answers.get(id)) : '—'}</Table.Td>
                    ))}
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Card>
      )}
    </Stack>
  );
}
