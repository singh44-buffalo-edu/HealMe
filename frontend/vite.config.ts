/**
 * Vite config — deliberately minimal: stock React plugin, no dev proxy. The
 * app talks to Medplum (:8103) and the ai-service (:8000) directly via
 * VITE_MEDPLUM_BASE_URL / VITE_AI_SERVICE_URL, which are baked in at build
 * time (only VITE_-prefixed vars reach client code). Dev server: :5173 via
 * `make dev`. PostCSS side of the build lives in postcss.config.mjs.
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})
