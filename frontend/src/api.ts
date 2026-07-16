/** Client for the local Python AI service (:8000). */

const RAW_BASE: string = import.meta.env.VITE_AI_SERVICE_URL ?? 'http://localhost:8000/';
const AI_BASE = RAW_BASE.endsWith('/') ? RAW_BASE : `${RAW_BASE}/`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(AI_BASE + path, init);
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

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export interface AiStatus {
  provider: string | null;
  model: string | null;
  configured: boolean;
  reason: string | null;
}

export const getAiHealth = () =>
  request<{ status: string; medplum_configured: boolean; ai: AiStatus }>('health');

export interface ReviewResult {
  document_reference_id: string;
  generated_at: string;
  window_days?: number;
  description?: string;
  markdown: string;
}

export const generateReview = (windowDays: number) =>
  request<ReviewResult>('health-review', json({ window_days: windowDays }));

export const generateDataSummary = (windowDays: number) =>
  request<ReviewResult>('health-review/data-summary', json({ window_days: windowDays }));

export const exportFhirUrl = `${AI_BASE}export/fhir`;
export const exportCsvUrl = `${AI_BASE}export/observations.csv`;

export const getLatestReview = () => request<ReviewResult>('health-review/latest');

export const reviewPdfUrl = (docId: string) => `${AI_BASE}health-review/${docId}/pdf`;

export interface UploadResult {
  document_reference_id: string;
  document_kind?: string;
  extraction_method: string;
  text_chars: number;
  proposals_created: number;
  note?: string;
}

export const uploadDocument = (file: File) => {
  const form = new FormData();
  form.append('file', file);
  return request<UploadResult>('ingest/upload', { method: 'POST', body: form });
};

export interface ImportResult {
  imported: number;
  already_existed: number;
  prepared: number;
  skipped: Record<string, number>;
}

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

export interface ReviewTask {
  task_id: string;
  description: string;
  confidence: number | null;
  source_excerpt: string | null;
  document_reference: string | null;
  authored_on: string | null;
  resource: Record<string, unknown> | null;
}

export const listReviewTasks = () => request<ReviewTask[]>('ingest/tasks');

export const approveTask = (taskId: string, resource: Record<string, unknown> | null) =>
  request<{ committed: string }>(`ingest/tasks/${encodeURIComponent(taskId)}/approve`, json({ resource }));

export const rejectTask = (taskId: string) =>
  request<{ status: string }>(`ingest/tasks/${encodeURIComponent(taskId)}/reject`, { method: 'POST' });

// ---------------------------------------------------------------------------
// AI settings (BYOK, per-feature routing) — /ai
// ---------------------------------------------------------------------------

export type AiRoute = 'local' | 'cloud' | 'off';
export type AiFeature = 'health-review' | 'ingest-extraction' | 'assistant' | 'nl-import';

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

export const getAiSettings = () => request<AiSettings>('ai/settings');

export const putAiSettings = (body: {
  routing?: Partial<Record<AiFeature, AiRoute>>;
  cloud_provider?: string;
  models?: Record<string, string>;
}) => request<AiSettings>('ai/settings', { ...json(body), method: 'PUT' });

export const setAiKey = (provider: string, key: string) =>
  request<{ provider: string; configured: boolean; masked_key: string }>(
    `ai/keys/${encodeURIComponent(provider)}`,
    json({ key })
  );

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

export const testAiProvider = (provider: string) =>
  request<AiTestResult>(`ai/test/${encodeURIComponent(provider)}`, { method: 'POST' });

// ---------------------------------------------------------------------------
// Assistant (record-grounded Q&A, read-only) — /assistant
// ---------------------------------------------------------------------------

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

export const askAssistant = (question: string) =>
  request<AssistantAnswer>('assistant/ask', json({ question }));

export interface AssistantSession {
  id: string;
  question: string;
  answer_preview: string;
  sent: string;
}

export const listAssistantSessions = () => request<AssistantSession[]>('assistant/sessions');

export const deleteAssistantSession = (id: string) =>
  request<{ id: string; deleted: boolean }>(`assistant/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

export const nlImport = (text: string) =>
  request<{ proposals: number; task_ids: string[]; note?: string }>(
    'assistant/nl-import',
    json({ text })
  );
