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
