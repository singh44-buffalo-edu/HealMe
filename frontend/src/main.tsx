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

const medplum = new MedplumClient({
  baseUrl: import.meta.env.VITE_MEDPLUM_BASE_URL ?? 'http://localhost:8103/',
});

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
