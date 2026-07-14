import { AppShell, Button, Center, Group, Loader, NavLink, Stack, Text, Title } from '@mantine/core';
import { SignInForm, useMedplum, useMedplumProfile } from '@medplum/react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { AdherencePage } from './pages/AdherencePage';
import { CartridgesPage } from './pages/CartridgesPage';
import { CheckinExplorerPage } from './pages/CheckinExplorerPage';
import { CheckinPage } from './pages/CheckinPage';
import { IngestPage } from './pages/IngestPage';
import { LabsPage } from './pages/LabsPage';
import { LogPage } from './pages/LogPage';
import { OverviewPage } from './pages/OverviewPage';
import { ReviewPage } from './pages/ReviewPage';
import { TimelinePage } from './pages/TimelinePage';
import { TrendsPage } from './pages/TrendsPage';

const NAV = [
  { to: '/', label: 'Adherence' },
  { to: '/overview', label: 'Health overview' },
  { to: '/trends', label: 'Trends' },
  { to: '/labs', label: 'Labs' },
  { to: '/timeline', label: 'Timeline' },
  { to: '/checkin', label: 'Daily check-in' },
  { to: '/checkins', label: 'Check-in explorer' },
  { to: '/log', label: 'Quick add' },
  { to: '/cartridges', label: 'Cartridges' },
  { to: '/ingest', label: 'Documents' },
  { to: '/review', label: 'Health Review' },
];

export function App() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const location = useLocation();

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

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: 'sm' }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Title order={3}>HealMeDaily</Title>
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              Not medical advice — a personal record & discussion aid
            </Text>
            <Button
              size="compact-sm"
              variant="subtle"
              onClick={() => medplum.signOut().then(() => window.location.reload())}
            >
              Sign out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            component={Link}
            to={item.to}
            label={item.label}
            active={location.pathname === item.to}
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main>
        <Routes>
          <Route path="/" element={<AdherencePage />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/trends" element={<TrendsPage />} />
          <Route path="/labs" element={<LabsPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/checkin" element={<CheckinPage />} />
          <Route path="/checkins" element={<CheckinExplorerPage />} />
          <Route path="/log" element={<LogPage />} />
          <Route path="/cartridges" element={<CartridgesPage />} />
          <Route path="/ingest" element={<IngestPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
