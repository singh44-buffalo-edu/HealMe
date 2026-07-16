import { FileInput, Loader, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconDownload, IconFileImport, IconFileText, IconScan } from '@tabler/icons-react';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewTask } from '../api';
import {
  approveTask,
  exportCsvUrl,
  exportFhirUrl,
  importStructured,
  listReviewTasks,
  rejectTask,
  uploadDocument,
} from '../api';
import { AIPill, CardTitle, ConfidenceBar, DsCard, PageHeader, PillButton, StatusDot } from '../components/ds';
import { T, mono } from '../tokens';

// ---------------------------------------------------------------------------
// Local presentation helpers
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Design date format: `Jul 15 2026` — no comma, no zero-padding. */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

/** Human word for the proposed entry kind — never surface backend nouns. */
const TYPE_LABEL: Record<string, string> = {
  Observation: 'observation',
  MedicationRequest: 'medication',
  MedicationStatement: 'medication',
  Condition: 'condition',
  AllergyIntolerance: 'allergy',
  Immunization: 'immunization',
  DiagnosticReport: 'lab report',
  Procedure: 'procedure',
};

function taskKind(task: ReviewTask): string {
  const rt = task.resource?.['resourceType'];
  return typeof rt === 'string' ? (TYPE_LABEL[rt] ?? rt.toLowerCase()) : 'entry';
}

function chipLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function IconTile({
  bg,
  fg,
  size = 34,
  radius = 10,
  children,
}: {
  bg: string;
  fg: string;
  size?: number;
  radius?: number;
  children: ReactNode;
}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: bg,
        color: fg,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        borderRadius: 20,
        padding: '7px 15px',
        fontSize: 12.5,
        fontWeight: 500,
        fontFamily: 'inherit',
        color: active ? '#fff' : T.secondary,
        background: active ? T.ink : T.card,
        boxShadow: active ? 'none' : '0 1px 2px rgba(0,0,0,.05)',
      }}
    >
      {label} <span style={mono(10.5, 500, active ? '#d1d1d6' : T.quaternary)}>{count}</span>
    </button>
  );
}

/** Green assurance line: dot + mono copy. */
function AssuranceLine({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, ...style }}>
      <StatusDot color={T.inRange} size={6} />
      <span style={mono(11, 400, T.tertiary)}>{children}</span>
    </div>
  );
}

const PILL_LINK: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  background: T.band,
  color: T.secondary,
  fontWeight: 500,
  fontSize: 13,
  borderRadius: 20,
  padding: '8px 16px',
};

const LINK_BUTTON: CSSProperties = {
  border: 'none',
  background: 'none',
  padding: 0,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 500,
  color: T.green,
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function IngestPage() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [tasks, setTasks] = useState<ReviewTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState('All');
  const uploadRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      setTasks(await listReviewTasks());
      setError(undefined);
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const result = await uploadDocument(file);
      notifications.show({
        color: 'teal',
        title: 'Document stored',
        message:
          result.note ??
          `${result.document_kind ?? 'document'} · ${result.extraction_method} · ${result.proposals_created} proposal(s) to review`,
        autoClose: 8000,
      });
      setFile(null);
      await reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Upload failed', message: normalizeErrorString(err) });
    } finally {
      setUploading(false);
    }
  };

  // Queue filter chips derive from the proposed entry kinds (client-side only).
  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tasks) {
      const k = chipLabel(taskKind(t));
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [tasks]);
  const effectiveFilter = filter !== 'All' && kinds.some(([k]) => k === filter) ? filter : 'All';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Documents"
        subtitle={
          loading || error
            ? 'originals always kept · extraction never overwrites'
            : `${tasks.length} awaiting review · originals always kept · extraction never overwrites`
        }
        right={
          <PillButton
            variant="primary"
            onClick={() => uploadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            ＋ Add document
          </PillButton>
        }
      />

      {/* ---- Add a document (upload → extraction proposals) ---- */}
      <div ref={uploadRef}>
        <DsCard padding={22} gap={13}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <IconTile bg={T.greenTint} fg={T.green}>
              <IconScan size={16} stroke={1.7} />
            </IconTile>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <CardTitle size={15}>Add a document</CardTitle>
              <span style={mono(10.5, 400, T.tertiary)}>PDF · PNG · JPEG · original stored unchanged</span>
            </div>
          </div>
          <span style={{ fontSize: 13, color: T.secondary, lineHeight: 1.55 }}>
            Upload a lab report, prescription or discharge summary (PDF/photo). The original is stored unchanged;
            the AI proposes structured entries which{' '}
            <b style={{ color: T.ink }}>you review below before anything joins your record</b>.
          </span>
          <span style={{ fontSize: 11.5, color: T.quaternary, lineHeight: 1.5 }}>
            Privacy: with a cloud AI provider configured, the document content is sent to that provider for
            extraction. Without one, the document is stored and no extraction happens.
          </span>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
            <FileInput
              label="File"
              placeholder="Choose PDF / PNG / JPEG"
              accept="application/pdf,image/png,image/jpeg"
              value={file}
              onChange={setFile}
              w={320}
              clearable
            />
            <PillButton variant="primary" onClick={upload} disabled={!file || uploading}>
              {uploading ? 'Uploading…' : 'Upload & extract'}
            </PillButton>
          </div>
          <AssuranceLine style={{ borderTop: `1px solid ${T.chip}`, paddingTop: 12 }}>
            Everything lands in your review queue first — nothing enters the record unapproved.
          </AssuranceLine>
        </DsCard>
      </div>

      {/* ---- Review queue — the gate into the record ---- */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-.015em' }}>Review queue</span>
          <span style={{ fontSize: 13, color: T.secondary }}>
            {!loading && !error
              ? `${tasks.length} ${tasks.length === 1 ? 'item' : 'items'} awaiting your approval — nothing enters the record without you.`
              : 'Nothing enters the record without you.'}
          </span>
        </div>

        {!loading && !error && kinds.length > 1 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <FilterChip
              label="All"
              count={tasks.length}
              active={effectiveFilter === 'All'}
              onClick={() => setFilter('All')}
            />
            {kinds.map(([k, c]) => (
              <FilterChip key={k} label={k} count={c} active={effectiveFilter === k} onClick={() => setFilter(k)} />
            ))}
          </div>
        )}

        {loading && (
          <DsCard padding="16px 22px" gap={0} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 } as CSSProperties}>
            <Loader size="xs" />
            <span style={mono(11.5, 400, T.quaternary)}>loading review queue…</span>
          </DsCard>
        )}
        {error && (
          <DsCard padding="16px 22px" gap={4}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <StatusDot color={T.outOfRange} size={7} />
              <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-.01em' }}>
                Could not load the review queue
              </span>
            </div>
            <span style={{ ...mono(11.5, 400, T.secondary), paddingLeft: 16 }}>{error}</span>
          </DsCard>
        )}
        {!loading && !error && tasks.length === 0 && (
          <DsCard padding="26px 22px" gap={0}>
            <span style={{ ...mono(12, 400, T.quaternary), textAlign: 'center' }}>
              Nothing waiting for review. Upload a document to create proposals.
            </span>
          </DsCard>
        )}
        {/* All TaskCards stay mounted; filtering only hides them (display:none), so
            in-progress edits to a proposed resource survive chip toggles. */}
        {tasks.map((task) => (
          <div
            key={task.task_id}
            style={
              effectiveFilter !== 'All' && chipLabel(taskKind(task)) !== effectiveFilter
                ? { display: 'none' }
                : undefined
            }
          >
            <TaskCard task={task} onChanged={reload} />
          </div>
        ))}

        {!loading && !error && (
          <AssuranceLine style={{ padding: '4px 2px' }}>
            Approving files the results into your record with their source attached. Rejected items keep the
            original file, marked “not entered”.
          </AssuranceLine>
        )}
      </div>

      <ImportCard />

      {/* ---- Export ---- */}
      <DsCard padding={22} gap={13}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <IconTile bg={T.band} fg={T.ink}>
            <IconDownload size={16} stroke={1.7} />
          </IconTile>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <CardTitle size={15}>Export your record</CardTitle>
            <span style={mono(10.5, 400, T.tertiary)}>FHIR R4 bundle · observations CSV</span>
          </div>
        </div>
        <span style={{ fontSize: 13, color: T.secondary, lineHeight: 1.55 }}>
          You own everything here. Download the complete record as a FHIR R4 bundle (portable to any FHIR
          system) or all observations as CSV.
        </span>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <a href={exportFhirUrl} target="_blank" rel="noreferrer" style={PILL_LINK}>
            Download FHIR bundle (JSON)
          </a>
          <a href={exportCsvUrl} target="_blank" rel="noreferrer" style={PILL_LINK}>
            Download observations (CSV)
          </a>
        </div>
      </DsCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import card (deterministic structured importers)
// ---------------------------------------------------------------------------

function ImportCard() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const doImport = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await importStructured(file);
      const skippedTotal = Object.values(result.skipped ?? {}).reduce((a, b) => a + b, 0);
      notifications.show({
        color: 'teal',
        title: 'Import finished',
        message: `${result.imported} imported, ${result.already_existed} already present${
          skippedTotal ? `, ${skippedTotal} skipped (unsupported/incomplete)` : ''
        }`,
        autoClose: 10000,
      });
      setFile(null);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Import failed', message: normalizeErrorString(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DsCard padding={22} gap={13}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <IconTile bg={T.band} fg={T.ink}>
          <IconFileImport size={16} stroke={1.7} />
        </IconTile>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <CardTitle size={15}>Import records</CardTitle>
          <span style={mono(10.5, 400, T.tertiary)}>FHIR bundle · CSV · Apple Health · deterministic, never duplicates</span>
        </div>
      </div>
      <span style={{ fontSize: 13, color: T.secondary, lineHeight: 1.55 }}>
        Bring history from elsewhere — a <b style={{ color: T.ink }}>FHIR R4 bundle</b> (.json) from a hospital
        portal, an <b style={{ color: T.ink }}>observations CSV</b> (this app's export format), or an{' '}
        <b style={{ color: T.ink }}>Apple Health</b> export.xml. Imports are deterministic: re-importing the
        same file never duplicates, everything is tagged <span style={mono(11.5, 500, T.secondary)}>imported</span>{' '}
        with provenance.
      </span>
      <span style={{ fontSize: 11.5, color: T.quaternary, lineHeight: 1.5 }}>
        Prefer hands-off? Drop files into <span style={mono(11, 500, T.tertiary)}>data/inbox/</span> — they are
        imported automatically (PDFs/photos go through the review queue).
      </span>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <FileInput
          label="File"
          placeholder="Choose .json / .csv / .xml"
          accept=".json,.csv,.xml,application/json,text/csv,text/xml"
          value={file}
          onChange={setFile}
          w={320}
          clearable
        />
        <PillButton variant="primary" onClick={doImport} disabled={!file || busy}>
          {busy ? 'Importing…' : 'Import'}
        </PillButton>
      </div>
    </DsCard>
  );
}

// ---------------------------------------------------------------------------
// Queue card — one AI-extracted proposal, approve/reject gate
// ---------------------------------------------------------------------------

function TaskCard({ task, onChanged }: { task: ReviewTask; onChanged: () => void }) {
  const medplum = useMedplum();
  const [json, setJson] = useState(() => JSON.stringify(task.resource, null, 2));
  const [busy, setBusy] = useState(false);

  // Visual gate only — approve() below still validates before any call.
  const jsonValid = useMemo(() => {
    try {
      JSON.parse(json);
      return true;
    } catch {
      return false;
    }
  }, [json]);

  const confColor =
    task.confidence == null
      ? T.quaternary
      : task.confidence >= 0.8
        ? T.inRange
        : task.confidence >= 0.5
          ? T.watch
          : T.outOfRange;

  const approve = async () => {
    setBusy(true);
    try {
      let resource: Record<string, unknown> | null = null;
      try {
        resource = JSON.parse(json);
      } catch {
        throw new Error('The resource JSON is not valid JSON — fix it before approving');
      }
      const result = await approveTask(task.task_id, resource);
      notifications.show({ color: 'teal', message: `Committed ${result.committed}` });
      onChanged();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Approve failed', message: normalizeErrorString(err) });
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await rejectTask(task.task_id);
      notifications.show({ color: 'yellow', message: 'Proposal rejected' });
      onChanged();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Reject failed', message: normalizeErrorString(err) });
    } finally {
      setBusy(false);
    }
  };

  const openSource = async () => {
    try {
      if (!task.document_reference) throw new Error('no source document');
      const doc = await medplum.readResource(
        'DocumentReference',
        task.document_reference.split('/')[1]
      );
      const url = doc.content?.[0]?.attachment?.url;
      if (!url) throw new Error('source document has no attachment');
      const blob = await medplum.download(url);
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not open source', message: normalizeErrorString(err) });
    }
  };

  return (
    <DsCard padding="18px 22px" gap={14}>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 16, alignItems: 'center' }}>
        <IconTile bg={T.aiBg} fg={T.ai} size={38} radius={12}>
          <IconFileText size={16} stroke={1.7} />
        </IconTile>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: '-.01em' }}>{task.description}</span>
            <AIPill />
            <span style={mono(9.5, 500, T.watch)}>AWAITING REVIEW</span>
            {task.confidence != null && task.confidence < 0.5 && (
              <span style={mono(9.5, 500, T.outOfRange)}>low confidence — check carefully</span>
            )}
          </div>
          <span style={mono(11, 400, T.tertiary)}>
            {taskKind(task)} · extracted by AI · original document kept
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {task.confidence != null ? (
              <>
                <div style={{ width: 120 }}>
                  <ConfidenceBar value={task.confidence} />
                </div>
                <span style={mono(9.5, 400, confColor)}>conf {task.confidence.toFixed(2)}</span>
              </>
            ) : (
              <span style={mono(9.5, 400, T.quaternary)}>conf n/a</span>
            )}
            {task.authored_on ? (
              <span style={mono(9.5, 400, T.quaternary)}>· {fmtDate(task.authored_on)}</span>
            ) : null}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <PillButton
            variant="primary"
            size={12.5}
            style={{ padding: '7px 16px' }}
            onClick={approve}
            disabled={busy || !jsonValid}
            disabledReason={jsonValid ? undefined : 'Fix the JSON before approving'}
          >
            Approve & commit
          </PillButton>
          <PillButton variant="secondary" size={12.5} onClick={reject} disabled={busy}>
            Reject
          </PillButton>
        </div>
      </div>

      {task.source_excerpt && (
        <div
          style={{
            background: T.band,
            borderRadius: 10,
            padding: '10px 14px',
            fontSize: 12,
            color: T.secondary,
            lineHeight: 1.5,
          }}
        >
          {task.source_excerpt}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${T.band}`, paddingTop: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: T.secondary }}>
          Proposed FHIR resource (edit before approving if needed)
        </span>
        <Textarea
          value={json}
          onChange={(e) => setJson(e.currentTarget.value)}
          autosize
          minRows={4}
          maxRows={16}
          styles={{
            input: {
              fontFamily: T.mono,
              fontSize: 12,
              border: `1px solid ${T.chip}`,
              borderRadius: 10,
              background: '#fbfbfa',
            },
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" onClick={openSource} style={LINK_BUTTON}>
            View source document
          </button>
          <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>original stored unchanged</span>
        </div>
      </div>
    </DsCard>
  );
}
