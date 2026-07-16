/**
 * Shell-switching breakpoint hook. App.tsx uses this single signal to choose
 * MobileShell vs the desktop sidebar shell; pages may also use it for layout
 * tweaks but must render acceptably in either shell. Subscribes to
 * matchMedia, so crossing 767px re-renders live without a reload.
 */
import { useEffect, useState } from 'react';

// 767px = just under the design handoff's tablet cut; mobile frames are
// specced at 390×844. Independent of Mantine's em breakpoints
// (postcss.config.mjs) — this one only decides which shell renders.
const QUERY = '(max-width: 767px)';

/** True below the mobile breakpoint (design reference frame 390×844). */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return mobile;
}
