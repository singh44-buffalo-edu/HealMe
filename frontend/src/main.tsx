/**
 * Frontend entry point: mounts React and wires the three global providers —
 * BrowserRouter → MedplumProvider (FHIR client + auth session) →
 * MantineProvider (design theme). Everything below <App /> reaches the CDR
 * through this single MedplumClient via useMedplum().
 *
 * CSS import order matters: Mantine + Medplum styles are REQUIRED or their
 * components render broken (CLAUDE.md §5 React). IBM Plex Mono is bundled
 * via @fontsource — never load fonts from a CDN (privacy promise: nothing
 * leaves the device). theme.css (design tokens + globals) loads last so its
 * rules win.
 */
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@medplum/react/styles.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './theme.css';

import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { MedplumClient } from '@medplum/core';
import { MedplumProvider } from '@medplum/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { theme } from './theme';

// VITE_-prefixed env vars are baked in at build time (not runtime config);
// the default targets the self-hosted Medplum server from infra/docker-compose.
const medplum = new MedplumClient({
  baseUrl: import.meta.env.VITE_MEDPLUM_BASE_URL ?? 'http://localhost:8103/',
});

// PWA offline shell — production only, never caches health data (see public/sw.js)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // offline shell is best-effort
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <MedplumProvider medplum={medplum}>
        <MantineProvider theme={theme}>
          <Notifications />
          <App />
        </MantineProvider>
      </MedplumProvider>
    </BrowserRouter>
  </StrictMode>
);
