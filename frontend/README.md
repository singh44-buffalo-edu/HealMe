# HealMeDaily frontend

Vite + React + `@medplum/react` (Mantine 8). See the repo root [README](../README.md) and
[CLAUDE.md](../CLAUDE.md) for architecture, conventions, and run commands.

```bash
npm run dev     # http://localhost:5173 (expects Medplum stack via `make up`)
npm test        # vitest — unit tests for the dose/adherence core (src/fhir.test.ts)
npm run lint    # oxlint
npm run build   # tsc + production bundle (served by nginx in `make prod-up`)
```

Layout: `src/fhir.ts` (FHIR helpers + adherence math — keep pure and tested),
`src/api.ts` (AI-service client), `src/pages/*` (one route each), `src/components/*`.
