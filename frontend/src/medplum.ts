/**
 * The one MedplumClient instance. Lives in its own module (not main.tsx) so
 * non-React code — api.ts's fetch wrapper needs the current access token for
 * the ai-service's session gate — can import it without pulling in the app
 * entry point (which would be an import cycle: main → App → pages → api).
 */
import { MedplumClient } from '@medplum/core';

// VITE_-prefixed env vars are baked in at build time (not runtime config);
// the default targets the self-hosted Medplum server from infra/docker-compose.
export const medplum = new MedplumClient({
  baseUrl: import.meta.env.VITE_MEDPLUM_BASE_URL ?? 'http://localhost:8103/',
});
