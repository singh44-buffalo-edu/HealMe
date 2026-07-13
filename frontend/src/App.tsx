import { Alert, Anchor, Button, Center, Container, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { getDisplayString, normalizeErrorString } from '@medplum/core';
import type { Patient } from '@medplum/fhirtypes';
import { Document, SignInForm, useMedplum, useMedplumProfile } from '@medplum/react';
import { useEffect, useState } from 'react';

const PATIENT_IDENTIFIER_SYSTEM = 'https://healmedaily.local/fhir/identifier/patient';
const PATIENT_IDENTIFIER_VALUE = 'healmedaily-user';

export function App() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();

  if (medplum.isLoading()) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  if (!profile) {
    return (
      <Center h="100vh">
        <Stack align="center">
          <Title order={2}>HealMeDaily</Title>
          <Text c="dimmed" size="sm">
            Private personal health record — sign in with your local Medplum account
          </Text>
          <SignInForm>Sign in</SignInForm>
        </Stack>
      </Center>
    );
  }

  return <Home />;
}

function Home() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [patient, setPatient] = useState<Patient | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    medplum
      .searchOne('Patient', { identifier: `${PATIENT_IDENTIFIER_SYSTEM}|${PATIENT_IDENTIFIER_VALUE}` })
      .then(setPatient)
      .catch((err) => setError(normalizeErrorString(err)))
      .finally(() => setLoading(false));
  }, [medplum]);

  return (
    <Container size="sm" py="xl">
      <Document>
        <Stack>
          <Group justify="space-between">
            <Title order={2}>HealMeDaily</Title>
            <Button variant="subtle" onClick={() => medplum.signOut().then(() => window.location.reload())}>
              Sign out
            </Button>
          </Group>
          <Text>
            Signed in as <b>{profile ? getDisplayString(profile) : '…'}</b>
          </Text>
          {loading && <Loader size="sm" />}
          {!loading && patient && (
            <Alert color="teal" title="Walking skeleton is alive">
              Patient record found: <b>{getDisplayString(patient)}</b> (Patient/{patient.id}). The browser is talking
              FHIR to the local Medplum server.
            </Alert>
          )}
          {!loading && !patient && !error && (
            <Alert color="yellow" title="No patient record yet">
              Run <code>make seed</code> to create the Patient and sample data.
            </Alert>
          )}
          {error && (
            <Alert color="red" title="FHIR request failed">
              {error}
            </Alert>
          )}
          <Text size="sm" c="dimmed">
            Admin console: <Anchor href="http://localhost:3000">Medplum App</Anchor> · API:{' '}
            <Anchor href="http://localhost:8103/healthcheck">healthcheck</Anchor>
          </Text>
        </Stack>
      </Document>
    </Container>
  );
}
