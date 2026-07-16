/**
 * MorePage — mobile "Health hub" (design Mobile 4d): full nav parity behind the
 * More tab. Every route as a 44px tap row, grouped Health / Capture / Privacy &
 * settings, plus the sidebar footer content (record count, disclaimer, sign out).
 *
 * Architecture: routed from App.tsx (mobile shell's More tab); consumes the
 * NAV / NAV_SETTINGS route registries and the shared count hooks from App —
 * it defines no routes of its own, so a route added to App appears here
 * automatically (that's the "parity by construction" below). Reads nothing
 * from FHIR directly; the only action is Medplum sign-out.
 *
 * Invariants: the review-queue badge rides the /ingest row only (mirrors the
 * sidebar badge); AI-flavored routes get the indigo icon treatment via
 * item.ai (AI-labeling rule, CLAUDE.md §2); the not-medical-advice footer
 * line ships on this surface too.
 */
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconChevronRight } from '@tabler/icons-react';
import { Link } from 'react-router';
import { NAV, NAV_SETTINGS, useRecordCount, useReviewQueueCount, type NavItem } from '../App';
import { DsCard, Eyebrow, PageHeader } from '../components/ds';
import { T, mono } from '../tokens';

/** Health-data surfaces; every other NAV route falls into Capture — parity by construction. */
const HEALTH_PATHS = new Set([
  '/overview',
  '/',
  '/vitals',
  '/labs',
  '/trends',
  '/correlations',
  '/timeline',
  '/review',
]);

interface Section {
  eyebrow: string;
  caption: string;
  items: NavItem[];
}

/** One 44px tap row: icon tile (indigo when item.ai), label, optional count
 * badge, chevron. `first` suppresses the hairline divider on group tops. */
function NavRow({ item, first, badge }: { item: NavItem; first: boolean; badge?: number }) {
  const IconCmp = item.icon;
  return (
    <Link
      to={item.to}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minHeight: 44,
        padding: '5px 16px',
        borderTop: first ? 'none' : `1px solid ${T.band}`,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          background: item.ai ? T.aiBg : T.band,
          color: item.ai ? T.ai : T.secondary,
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
        }}
      >
        <IconCmp size={17} stroke={1.7} />
      </span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 500,
          letterSpacing: '-.01em',
          color: item.ai ? T.ai : T.ink,
        }}
      >
        {item.label}
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {badge !== undefined ? (
          <span
            style={{
              ...mono(10, 500, T.ai),
              background: T.aiBg,
              borderRadius: 10,
              padding: '2px 7px',
            }}
          >
            {badge}
          </span>
        ) : null}
        <IconChevronRight size={15} stroke={1.7} style={{ color: T.quaternary }} />
      </span>
    </Link>
  );
}

/**
 * The hub itself: three grouped nav sections plus the footer (observation
 * count, disclaimer, profile name, sign out). Sign-out clears the Medplum
 * session and hard-reloads so no per-page state survives the identity change.
 */
export function MorePage() {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const reviewCount = useReviewQueueCount();
  const recordCount = useRecordCount();

  const sections: Section[] = [
    {
      eyebrow: 'Health',
      caption: 'records · trends · reviews',
      items: NAV.filter((n) => HEALTH_PATHS.has(n.to)),
    },
    {
      eyebrow: 'Capture',
      caption: 'log it · check in · bring documents home',
      items: NAV.filter((n) => !HEALTH_PATHS.has(n.to)),
    },
    {
      eyebrow: 'Privacy & settings',
      caption: 'what happened · who sees it · how AI runs',
      items: NAV_SETTINGS,
    },
  ];

  return (
    <>
      <PageHeader title="Your health" subtitle="every surface, one tap away" />

      {sections.map((s) => (
        <div key={s.eyebrow} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 2px' }}>
            <Eyebrow>{s.eyebrow}</Eyebrow>
            <span style={mono(10, 400, T.quaternary)}>{s.caption}</span>
          </div>
          <DsCard flush>
            {s.items.map((item, i) => (
              <NavRow
                key={item.to}
                item={item}
                first={i === 0}
                badge={item.to === '/ingest' && reviewCount > 0 ? reviewCount : undefined}
              />
            ))}
          </DsCard>
        </div>
      ))}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 2px 8px' }}>
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
    </>
  );
}
