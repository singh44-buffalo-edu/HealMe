/**
 * MobileTabBar — floating blurred-white pill bottom nav (design Mobile 2a/4d).
 * Five slots: Today · Meds · center ＋ capture · Assistant · More.
 * Rendered only by MobileShell (App.tsx); every page not covered by the five
 * slots is reachable through More (/more), which reuses the desktop NAV list
 * so the shells never drift apart.
 */
import {
  IconLayoutDashboard,
  IconMenu2,
  IconMessageCircle,
  IconPill,
  IconPlus,
  type Icon,
} from '@tabler/icons-react';
import { Link, useLocation } from 'react-router';
import { T, mono } from '../tokens';

/** One tab slot: 44px minimum hit target, active = ink / inactive =
 * quaternary. The badge renders in AI indigo because the review queue it
 * counts holds AI-extraction proposals (AI-labeling rule). */
function Slot({
  to,
  label,
  icon: IconCmp,
  badge,
}: {
  to: string;
  label: string;
  icon: Icon;
  badge?: number;
}) {
  const location = useLocation();
  const active = location.pathname === to;
  const color = active ? T.ink : T.quaternary;
  return (
    <Link
      to={to}
      aria-label={label}
      style={{
        flex: 1,
        minWidth: 44,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        color,
        textDecoration: 'none',
        position: 'relative',
      }}
    >
      <IconCmp size={20} stroke={active ? 1.9 : 1.7} />
      <span style={mono(10, 500, color)}>{label}</span>
      {badge !== undefined && badge > 0 ? (
        <span
          style={{
            position: 'absolute',
            top: 7,
            left: '50%',
            marginLeft: 8,
            ...mono(9, 500, T.ai),
            background: T.aiBg,
            borderRadius: 10,
            padding: '1px 6px',
          }}
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

/** Fixed bottom tab bar; `reviewCount` renders the review-queue badge on
 * More. Bottom offset includes the iOS safe-area inset; MobileShell's main
 * padding reserves matching space so content never hides beneath the bar. */
export function MobileTabBar({ reviewCount = 0 }: { reviewCount?: number }) {
  return (
    <nav
      style={{
        position: 'fixed',
        left: 16,
        right: 16,
        bottom: 'calc(12px + env(safe-area-inset-bottom))',
        height: 60,
        display: 'flex',
        background: 'rgba(255,255,255,.88)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        borderRadius: 28,
        boxShadow: T.shadowCardHover,
        zIndex: 100,
      }}
    >
      <Slot to="/overview" label="Today" icon={IconLayoutDashboard} />
      <Slot to="/" label="Meds" icon={IconPill} />
      <Link
        to="/log"
        aria-label="Quick add"
        style={{
          flex: 1,
          minWidth: 44,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textDecoration: 'none',
        }}
      >
        <span
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: T.green,
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            transform: 'translateY(-14px)',
            boxShadow: '0 4px 12px rgba(15,138,99,.35)',
          }}
        >
          <IconPlus size={22} stroke={2.2} />
        </span>
      </Link>
      <Slot to="/assistant" label="Assistant" icon={IconMessageCircle} />
      <Slot to="/more" label="More" icon={IconMenu2} badge={reviewCount} />
    </nav>
  );
}
