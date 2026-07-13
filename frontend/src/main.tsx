import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@medplum/react/styles.css';

import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { MedplumClient } from '@medplum/core';
import { MedplumProvider } from '@medplum/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const medplum = new MedplumClient({
  baseUrl: import.meta.env.VITE_MEDPLUM_BASE_URL ?? 'http://localhost:8103/',
});

const theme = createTheme({
  primaryColor: 'teal',
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MedplumProvider medplum={medplum}>
      <MantineProvider theme={theme}>
        <Notifications />
        <App />
      </MantineProvider>
    </MedplumProvider>
  </StrictMode>
);
