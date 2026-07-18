/**
 * Typed client for the local Python ai-service (FastAPI, :8000). Everything
 * here is a plain fetch against `VITE_AI_SERVICE_URL`; FHIR CRUD does NOT go
 * through this file — pages use MedplumClient directly (see fhir.ts).
 *
 * Endpoint groups → the ai-service module that serves them (ai-service/app/…):
 * - `health`          → main.py (service liveness + Medplum/provider status)
 * - `health-review*`  → health_review.py (AI review + deterministic data
 *                       summary; PDF rendering in pdfgen.py)
 * - `export/*`        → export.py (full FHIR bundle / observations CSV)
 * - `ingest/*`        → ingest.py (uploads + review queue; the watched-folder
 *                       scan lives in watcher.py)
 * - `import/{kind}`   → importers.py (deterministic structured imports)
 * - `ai/*`            → ai_settings.py (BYOK keys via keystore.py, provider
 *                       adapters in providers.py)
 * - `assistant/*`     → assistant.py (record-grounded Q&A + NL quick capture)
 *
 * Safety invariants behind these endpoints (enforced server-side; the UI
 * must not paper over them): AI/OCR extractions only ever become clinical
 * resources through the review queue's approve step (FHIR-MAPPING §6); AI
 * answers always carry citations + the not-medical-advice disclaimer; data
 * is never sent to an unconfigured provider; every cloud call is preceded by
 * a boundary-ledger AuditEvent (CLAUDE.md §6 AI guardrails).
 */

import { medplum } from './medplum';

const RAW_BASE: string = import.meta.env.VITE_AI_SERVICE_URL ?? 'http://localhost:8000/';
const AI_BASE = RAW_BASE.endsWith('/') ? RAW_BASE : `${RAW_BASE}/`;

/** The ai-service requires the caller's Medplum session token on every
 * endpoint except /health (its auth.py gate) — forward the one the signed-in
 * app already holds. Never in a URL parameter, always a header.
 *
 * Refreshes first when the access token is expired: raw fetch (unlike the
 * SDK's own request path) does not auto-refresh, so after ~1 h idle the token
 * would be stale and the gate would answer a false "sign in again". */
async function authHeaders(): Promise<Record<string, string>> {
  try {
    // refreshIfExpired() self-guards (no-op when the token is still valid) —
    // needed because raw fetch, unlike the SDK's own request path, does not
    // auto-refresh; without it a call after ~1h idle sends a stale token.
    await medplum.refreshIfExpired();
  } catch {
    // Refresh failed (offline / refresh token gone) — send whatever we have;
    // the gate's 401 then surfaces the real reason.
  }
  const token = medplum.getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Shared fetch wrapper: distinguishes "service down" (friendly `make dev`
// hint) from real HTTP errors, and surfaces FastAPI's {detail} verbatim so
// server-side reasons ("no provider configured", validation) reach the UI.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = await authHeaders();
  let res: Response;
  try {
    res = await fetch(AI_BASE + path, {
      ...init,
      headers: { ...auth, ...(init?.headers as Record<string, string> | undefined) },
    });
  } catch {
    throw new Error('AI service is not reachable — is `make dev` running?');
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.detail) detail = String(body.detail);
    } catch {
      // non-JSON error body
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

/** Authenticated file download: fetch → blob → synthetic <a download> click.
 * Replaces plain hrefs — those cannot carry the Authorization header the
 * ai-service now requires, and tokens never belong in URLs. */
async function downloadBlob(path: string, filename: string): Promise<void> {
  const auth = await authHeaders();
  let res: Response;
  try {
    res = await fetch(AI_BASE + path, { headers: auth });
  } catch {
    throw new Error('AI service is not reachable — is `make dev` running?');
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.detail) detail = String(body.detail);
    } catch {
      // non-JSON error body
    }
    throw new Error(detail);
  }
  const url = URL.createObjectURL(await res.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoke on the next tick, not synchronously: some browsers abort a
  // large in-flight download if the object URL is freed the instant after
  // click().
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// POST-a-JSON-body shorthand.
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Active-provider readiness; `reason` says why it is not configured (the
 * app must boot with no AI key and show a "configure a provider" state). */
export interface AiStatus {
  provider: string | null;
  model: string | null;
  configured: boolean;
  reason: string | null;
}

/** Liveness + config probe (main.py): is the service up, can it reach
 * Medplum, and is an AI provider ready. Pages poll this to choose between
 * real AI UI and the unconfigured state. */
export const getAiHealth = () =>
  request<{ status: string; medplum_configured: boolean; ai: AiStatus }>('health');

/** A generated review/summary. Persisted server-side as DocumentReference +
 * Binary PDF (local type `health-review`, FHIR-MAPPING §2); `markdown` is
 * the on-screen copy of the same content. */
export interface ReviewResult {
  document_reference_id: string;
  generated_at: string;
  window_days?: number;
  description?: string;
  markdown: string;
}

/** Generate an AI Health Review over the trailing `windowDays` (owner default
 * 90; 30/custom selectable). Slow — one LLM round trip; fails with a clear
 * reason when no provider is configured. Each run stores a NEW document, so
 * this is deliberately not idempotent. Organizes only, never diagnoses. */
export const generateReview = (windowDays: number) =>
  request<ReviewResult>('health-review', json({ window_days: windowDays }));

/** Deterministic data-only clinician summary (spec FR-RPT-1/2): same shape
 * and persistence as the AI review but computed with no AI provider at all —
 * always available, even fully offline. */
export const generateDataSummary = (windowDays: number) =>
  request<ReviewResult>('health-review/data-summary', json({ window_days: windowDays }));

/** Authenticated exports (replacing the old direct-href URLs — plain links
 * cannot carry the session token the ai-service now requires). */
export const downloadFhirExport = () => downloadBlob('export/fhir', 'healmedaily-record.json');
export const downloadCsvExport = () => downloadBlob('export/observations.csv', 'observations.csv');

/** Most recent stored review; rejects (404 detail) when none exists yet. */
export const getLatestReview = () => request<ReviewResult>('health-review/latest');

/** Download a stored review PDF (every PDF carries the not-medical-advice
 * disclaimer — CLAUDE.md §6 AI guardrails). */
export const downloadReviewPdf = (docId: string) =>
  downloadBlob(`health-review/${encodeURIComponent(docId)}/pdf`, `health-review-${docId}.pdf`);

/** Outcome of a document upload: where the original landed and how many
 * extraction proposals now await human review. */
export interface UploadResult {
  document_reference_id: string;
  document_kind?: string;
  extraction_method: string;
  text_chars: number;
  proposals_created: number;
  note?: string;
}

/**
 * Upload a PDF/photo for OCR/AI extraction (ingest.py). The original is
 * stored immutably as DocumentReference + Binary; each extracted candidate
 * becomes a review-queue Task — NOTHING is committed to the clinical record
 * by this call (review-gate invariant, FHIR-MAPPING §6). Long-running
 * (OCR + model, tens of seconds); re-uploading the same file simply creates
 * fresh proposals. 25 MB server-side limit.
 */
export const uploadDocument = (file: File) => {
  const form = new FormData();
  form.append('file', file);
  return request<UploadResult>('ingest/upload', { method: 'POST', body: form });
};

/** Import tally; `already_existed` counts rows deduped by content-hash
 * identifier, `skipped` maps reason → count for anything not importable. */
export interface ImportResult {
  imported: number;
  already_existed: number;
  prepared: number;
  skipped: Record<string, number>;
}

/** Structured-import formats (importers.py): FHIR R4 bundle, this app's
 * observations-CSV export, Apple Health export.xml, C-CDA, HL7v2 ORU. */
export type ImportKind = 'fhir' | 'csv' | 'apple' | 'ccda' | 'hl7';

// .xml stays "apple" for backward compat — the server sniffs C-CDA roots and reroutes.
const IMPORT_KIND_BY_EXT: Record<string, ImportKind> = {
  json: 'fhir',
  csv: 'csv',
  xml: 'apple',
  cda: 'ccda',
  ccda: 'ccda',
  hl7: 'hl7',
};

/**
 * Deterministic structured import (Phase 4). Commits DIRECTLY to the record
 * with an `imported` tag + Provenance — the review queue is for AI
 * extractions only, and these parsers are deterministic. Safe to re-run:
 * dedup by sha256 content-hash identifier reports repeats as
 * `already_existed` instead of duplicating. `kind` overrides the extension
 * sniffing below; rejects unsupported extensions before any network call.
 */
export const importStructured = (file: File, kind?: ImportKind) => {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const resolved = kind ?? IMPORT_KIND_BY_EXT[ext];
  if (!resolved) {
    return Promise.reject(
      new Error(
        'Unsupported file — .json (FHIR bundle), .csv (observations export), .xml (Apple Health or C-CDA), .cda/.ccda (C-CDA) or .hl7 (HL7v2 ORU results)'
      )
    );
  }
  const form = new FormData();
  form.append('file', file);
  return request<ImportResult>(`import/${resolved}`, { method: 'POST', body: form });
};

/** One pending extraction proposal: the candidate resource JSON plus the
 * evidence a human reviewer needs (confidence, source excerpt, source doc). */
export interface ReviewTask {
  task_id: string;
  description: string;
  confidence: number | null;
  source_excerpt: string | null;
  document_reference: string | null;
  authored_on: string | null;
  resource: Record<string, unknown> | null;
}

/** Pending proposals (Task intent=proposal awaiting review) — feeds the
 * Documents page and the nav badge. */
export const listReviewTasks = () => request<ReviewTask[]>('ingest/tasks');

/**
 * Approve one proposal — the ONLY path by which AI/OCR output becomes a
 * clinical resource. `resource` carries the reviewer's edits (null keeps the
 * candidate as extracted). The server commits resource + Provenance + Task
 * completion in one transaction (FHIR-MAPPING §6); returns the committed
 * reference. Approving an already-completed task fails rather than
 * double-committing.
 */
export const approveTask = (taskId: string, resource: Record<string, unknown> | null) =>
  request<{ committed: string }>(`ingest/tasks/${encodeURIComponent(taskId)}/approve`, json({ resource }));

/** Reject a proposal: Task → rejected; no clinical resource is ever created,
 * and the immutable source document stays put. */
export const rejectTask = (taskId: string) =>
  request<{ status: string }>(`ingest/tasks/${encodeURIComponent(taskId)}/reject`, { method: 'POST' });

// ---------------------------------------------------------------------------
// AI settings (BYOK, per-feature routing) — /ai
// ---------------------------------------------------------------------------

/** Per-feature routing choice: 'local' = Ollama, data stays home (green) ·
 * 'cloud' = data leaves this machine (always disclosed, amber) · 'off'. */
export type AiRoute = 'local' | 'cloud' | 'off';
/** The four independently routable AI features (CLAUDE.md §7 phase 7). */
export type AiFeature = 'health-review' | 'ingest-extraction' | 'assistant' | 'nl-import';

/** Provider adapter status; `masked_key` is all the client ever sees of a
 * stored key — full keys never leave the keystore. */
export interface AiProviderInfo {
  name: string;
  is_local: boolean;
  configured: boolean;
  model: string;
  masked_key?: string;
  base_url?: string;
}

export interface AiSettings {
  providers: AiProviderInfo[];
  routing: Record<AiFeature, AiRoute>;
  cloud_provider: string | null;
}

/** Current providers + per-feature routing + chosen cloud provider. */
export const getAiSettings = () => request<AiSettings>('ai/settings');

/** Partial-update AI settings (routing, cloud provider, model overrides,
 * per-provider base URL overrides); returns the full updated settings.
 * Setting a feature to 'cloud' only routes it — every actual cloud call still
 * writes its boundary AuditEvent. `base_urls` maps provider → endpoint (e.g.
 * an OpenAI-compatible server); an empty string clears the override. */
export const putAiSettings = (body: {
  routing?: Partial<Record<AiFeature, AiRoute>>;
  cloud_provider?: string;
  models?: Record<string, string>;
  base_urls?: Record<string, string>;
}) => request<AiSettings>('ai/settings', { ...json(body), method: 'PUT' });

/** Store a BYOK API key. Server keeps it in the macOS Keychain (0600 file
 * fallback under data/secrets/); keys never touch FHIR, .env or record
 * exports (FHIR-MAPPING §11). Response echoes only a masked form. */
export const setAiKey = (provider: string, key: string) =>
  request<{ provider: string; configured: boolean; masked_key: string }>(
    `ai/keys/${encodeURIComponent(provider)}`,
    json({ key })
  );

/** Remove a stored key; the provider reverts to unconfigured and any feature
 * routed to it degrades to the "configure a provider" state. */
export const deleteAiKey = (provider: string) =>
  request<{ provider: string; deleted: boolean; configured: boolean }>(
    `ai/keys/${encodeURIComponent(provider)}`,
    { method: 'DELETE' }
  );

export interface AiTestResult {
  ok: boolean;
  provider: string;
  model?: string;
  latency_ms?: number;
  reply?: string;
  reason?: string;
}

/** One tiny round trip to verify a key/endpoint actually works; `reason`
 * explains failures. No health data is included in the test prompt. */
export const testAiProvider = (provider: string) =>
  request<AiTestResult>(`ai/test/${encodeURIComponent(provider)}`, { method: 'POST' });

// ---------------------------------------------------------------------------
// Assistant (record-grounded Q&A, read-only) — /assistant
// ---------------------------------------------------------------------------

/** One numbered citation — must resolve to a real FHIR resource; every claim
 * in an assistant answer is required to carry one (grounding rule). */
export interface AssistantCitation {
  n: number;
  resourceType: string;
  id: string;
  display: string;
  value?: string;
  date?: string;
}

export interface AssistantAnswer {
  answer_markdown: string;
  citations: AssistantCitation[];
  read_count: number;
  provider: { name: string; is_local: boolean };
  communication_id: string;
  disclaimer: string;
}

/**
 * Ask the record-grounded assistant. Read-only over the FHIR record — it can
 * never write clinical data. Each Q&A is persisted as a Communication
 * (FHIR-MAPPING §11) so it appears in sessions and can be deleted. Slow
 * (record search + LLM); fails cleanly when the routed provider is off or
 * unconfigured.
 */
export const askAssistant = (question: string) =>
  request<AssistantAnswer>('assistant/ask', json({ question }));

export interface AssistantSession {
  id: string;
  question: string;
  answer_preview: string;
  sent: string;
}

/** Past Q&A Communications, newest first. */
export const listAssistantSessions = () => request<AssistantSession[]>('assistant/sessions');

/** Delete one saved Q&A (server leaves an AuditEvent stub, FHIR-MAPPING §11). */
export const deleteAssistantSession = (id: string) =>
  request<{ id: string; deleted: boolean }>(`assistant/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

/**
 * Natural-language quick capture ("weighed 71 kg this morning"): the model
 * turns free text into proposal resources, but they ride the SAME review
 * queue as document ingestion (one Task per proposal, dedup by text hash) —
 * never a direct commit (FHIR-MAPPING §11 → §6).
 */
export const nlImport = (text: string) =>
  request<{ proposals: number; task_ids: string[]; note?: string }>(
    'assistant/nl-import',
    json({ text })
  );
