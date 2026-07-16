/* oxlint-disable react/only-export-components --
   NAV / NAV_SETTINGS / count hooks are intentionally shared with MorePage
   (mobile hub needs full nav parity); cost is full-reload HMR for this file. */
import { Center, Loader, Stack, Text, Title } from '@mantine/core';
import { SignInForm, useMedplum, useMedplumProfile } from '@medplum/react';
import {
  IconChartLine,
  IconCirclePlus,
  IconClipboardCheck,
  IconDeviceDesktop,
  IconFiles,
  IconFlask,
  IconHeart,
  IconHistory,
  IconLayoutDashboard,
  IconLock,
  IconMessageCircle,
  IconNotebook,
  IconPill,
  IconReportMedical,
  IconSettings,
  IconSparkles,
  IconStack2,
  IconTimeline,
  type Icon,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { listReviewTasks } from './api';
import { VaultChip } from './components/ds';
import { MobileTabBar } from './components/MobileTabBar';
import { T, mono } from './tokens';
import { useIsMobile } from './useIsMobile';
import { AccessControlPage } from './pages/AccessControlPage';
import { AdherencePage } from './pages/AdherencePage';
import { AiSettingsPage } from './pages/AiSettingsPage';
import { AssistantPage } from './pages/AssistantPage';
import { DevicesPage } from './pages/DevicesPage';
import { HistoryPage } from './pages/HistoryPage';
import { CartridgesPage } from './pages/CartridgesPage';
import { CheckinExplorerPage } from './pages/CheckinExplorerPage';
import { CheckinPage } from './pages/CheckinPage';
import { CorrelationsPage } from './pages/CorrelationsPage';
import { IngestPage } from './pages/IngestPage';
import { LabsPage } from './pages/LabsPage';
import { LogPage } from './pages/LogPage';
import { MorePage } from './pages/MorePage';
import { OverviewPage } from './pages/OverviewPage';
import { ReviewPage } from './pages/ReviewPage';
import { TimelinePage } from './pages/TimelinePage';
import { TrendsPage } from './pages/TrendsPage';
import { VitalsPage } from './pages/VitalsPage';

export interface NavItem {
  to: string;
  label: string;
  icon: Icon;
  ai?: boolean;
  badge?: number;
}

export const NAV: NavItem[] = [
  { to: '/overview', label: 'Dashboard', icon: IconLayoutDashboard },
  { to: '/', label: 'Medications', icon: IconPill },
  { to: '/vitals', label: 'Vitals', icon: IconHeart },
  { to: '/labs', label: 'Labs', icon: IconFlask },
  { to: '/devices', label: 'Devices', icon: IconDeviceDesktop },
  { to: '/trends', label: 'Trends', icon: IconChartLine },
  { to: '/correlations', label: 'Correlations', icon: IconSparkles },
  { to: '/timeline', label: 'Timeline', icon: IconTimeline },
  { to: '/checkin', label: 'Check-in', icon: IconClipboardCheck },
  { to: '/checkins', label: 'Check-in explorer', icon: IconNotebook },
  { to: '/log', label: 'Quick add', icon: IconCirclePlus },
  { to: '/assistant', label: 'Assistant', icon: IconMessageCircle, ai: true },
  { to: '/cartridges', label: 'Cartridges', icon: IconStack2 },
  { to: '/ingest', label: 'Documents', icon: IconFiles },
  { to: '/review', label: 'Health Review', icon: IconReportMedical },
];

/** Bottom nav cluster: privacy & configuration surfaces. */
export const NAV_SETTINGS: NavItem[] = [
  { to: '/history', label: 'History log', icon: IconHistory },
  { to: '/access', label: 'Access control', icon: IconLock },
  { to: '/ai-settings', label: 'AI settings', icon: IconSettings },
];

export function useReviewQueueCount(): number {
  const [count, setCount] = useState(0);
  const location = useLocation();
  useEffect(() => {
    let cancelled = false;
    listReviewTasks()
      .then((tasks) => {
        if (!cancelled) {
          setCount(tasks.length);
        }
      })
      .catch(() => {
        // ai-service not running — no badge
      });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);
  return count;
}

export function useRecordCount(): number | undefined {
  const medplum = useMedplum();
  const [count, setCount] = useState<number>();
  useEffect(() => {
    medplum
      .search('Observation', { _count: 1, _total: 'accurate' })
      .then((bundle) => setCount(bundle.total))
      .catch(() => setCount(undefined));
  }, [medplum]);
  return count;
}

/** Route table — shared between the desktop and mobile shells. */
function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<AdherencePage />} />
      <Route path="/overview" element={<OverviewPage />} />
      <Route path="/trends" element={<TrendsPage />} />
      <Route path="/vitals" element={<VitalsPage />} />
      <Route path="/correlations" element={<CorrelationsPage />} />
      <Route path="/labs" element={<LabsPage />} />
      <Route path="/timeline" element={<TimelinePage />} />
      <Route path="/checkin" element={<CheckinPage />} />
      <Route path="/checkins" element={<CheckinExplorerPage />} />
      <Route path="/log" element={<LogPage />} />
      <Route path="/cartridges" element={<CartridgesPage />} />
      <Route path="/ingest" element={<IngestPage />} />
      <Route path="/review" element={<ReviewPage />} />
      <Route path="/devices" element={<DevicesPage />} />
      <Route path="/assistant" element={<AssistantPage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/access" element={<AccessControlPage />} />
      <Route path="/ai-settings" element={<AiSettingsPage />} />
      <Route path="/more" element={<MorePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** Mobile shell (design 2a/4d): slim top row, full-width main, floating tab bar. */
function MobileShell() {
  const reviewCount = useReviewQueueCount();
  return (
    <div style={{ minHeight: '100vh', background: T.canvas }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px 0' }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: T.green,
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            fontSize: 14,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          H
        </div>
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-.015em' }}>HealMeDaily</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {reviewCount > 0 ? (
            <Link
              to="/ingest"
              style={{
                ...mono(10, 500, T.ai),
                background: T.aiBg,
                borderRadius: 10,
                padding: '3px 8px',
                textDecoration: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {reviewCount} to review
            </Link>
          ) : null}
          <VaultChip />
        </span>
      </header>
      <main
        style={{
          padding: '16px 16px calc(110px + env(safe-area-inset-bottom))',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxSizing: 'border-box',
          width: '100%',
        }}
      >
        <AppRoutes />
      </main>
      <MobileTabBar reviewCount={reviewCount} />
    </div>
  );
}

function Sidebar() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const location = useLocation();
  const reviewCount = useReviewQueueCount();
  const recordCount = useRecordCount();

  return (
    <aside
      style={{
        background: T.card,
        borderRight: `1px solid ${T.hairline}`,
        padding: '24px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        position: 'sticky',
        top: 0,
        height: '100vh',
        boxSizing: 'border-box',
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px' }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: T.green,
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          H
        </div>
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-.015em' }}>HealMeDaily</span>
      </div>

      <VaultChip fullWidth />

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {[...NAV, null, ...NAV_SETTINGS].map((item, i) => {
          if (item === null) {
            return (
              <span
                key={`divider-${i}`}
                style={{ height: 1, background: T.hairline, margin: '8px 10px' }}
              />
            );
          }
          const active = location.pathname === item.to;
          const badge = item.to === '/ingest' && reviewCount > 0 ? reviewCount : undefined;
          const IconCmp = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderRadius: 12,
                fontSize: 13.5,
                fontWeight: active ? 600 : 500,
                color: active ? T.ink : item.ai ? T.ai : T.secondary,
                background: active ? T.chip : 'transparent',
              }}
            >
              <span style={{ width: 18, display: 'grid', placeItems: 'center' }}>
                <IconCmp size={15} stroke={1.7} />
              </span>
              {item.label}
              {badge !== undefined ? (
                <span
                  style={{
                    marginLeft: 'auto',
                    ...mono(10, 500, T.ai),
                    background: T.aiBg,
                    borderRadius: 10,
                    padding: '2px 7px',
                  }}
                >
                  {badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div
        style={{
          marginTop: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '0 10px',
        }}
      >
        <span style={mono(10, 400, T.quaternary)}>
          {recordCount !== undefined ? `${recordCount.toLocaleString()} observations` : 'local record'}
        </span>
        <span style={{ fontSize: 11, color: T.quaternary }}>
          Not medical advice — a personal record &amp; discussion aid
        </span>
        <span style={{ fontSize: 12, color: T.tertiary }}>
          {profile?.name?.[0]?.given?.join(' ') ?? 'Owner'}
          {' · '}
          <a
            href="#signout"
            onClick={(e) => {
              e.preventDefault();
              medplum.signOut().then(() => window.location.reload());
            }}
          >
            Sign out
          </a>
        </span>
      </div>
    </aside>
  );
}

export function App() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const isMobile = useIsMobile();

  if (medplum.isLoading()) {
    return (
      <Center h="100vh">
        <Loader color="hmdGreen" />
      </Center>
    );
  }

  if (!profile) {
    return (
      <Center h="100vh" style={{ background: T.canvas }}>
        <div
          style={{
            background: T.card,
            borderRadius: 20,
            padding: '36px 40px',
            boxShadow: T.shadowCard,
          }}
        >
          <Stack align="center" gap="sm">
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                background: T.green,
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                fontSize: 20,
                fontWeight: 600,
              }}
            >
              H
            </div>
            <Title order={2} style={{ letterSpacing: '-.02em' }}>
              HealMeDaily
            </Title>
            <Text size="sm" style={{ color: T.secondary }}>
              Private personal health record — sign in with your local Medplum account
            </Text>
            <VaultChip />
            <SignInForm>Sign in</SignInForm>
          </Stack>
        </div>
      </Center>
    );
  }

  if (isMobile) {
    return <MobileShell />;
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '232px 1fr',
        minHeight: '100vh',
        minWidth: 1280,
        background: T.canvas,
      }}
    >
      <Sidebar />
      <main
        style={{
          padding: '32px 40px 64px',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
          maxWidth: 1180,
          boxSizing: 'border-box',
          width: '100%',
        }}
      >
        <AppRoutes />
      </main>
    </div>
  );
}
