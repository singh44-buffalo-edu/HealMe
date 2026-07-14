import {
  Alert,
  Badge,
  Blockquote,
  Button,
  Card,
  FileInput,
  Group,
  Loader,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
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

export function IngestPage() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [tasks, setTasks] = useState<ReviewTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

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

  return (
    <Stack>
      <Title order={2}>Documents & ingestion</Title>
      <Card withBorder>
        <Stack gap="xs">
          <Text size="sm">
            Upload a lab report, prescription or discharge summary (PDF/photo). The original is stored unchanged;
            the AI proposes structured entries which <b>you review below before anything joins your record</b>.
          </Text>
          <Text size="xs" c="dimmed">
            Privacy: with a cloud AI provider configured, the document content is sent to that provider for
            extraction. Without one, the document is stored and no extraction happens.
          </Text>
          <Group align="flex-end">
            <FileInput
              label="File"
              placeholder="Choose PDF / PNG / JPEG"
              accept="application/pdf,image/png,image/jpeg"
              value={file}
              onChange={setFile}
              w={320}
              clearable
            />
            <Button onClick={upload} loading={uploading} disabled={!file}>
              Upload & extract
            </Button>
          </Group>
        </Stack>
      </Card>

      <Title order={3}>Review queue</Title>
      {loading && <Loader />}
      {error && (
        <Alert color="red" title="Could not load the review queue">
          {error}
        </Alert>
      )}
      {!loading && !error && tasks.length === 0 && (
        <Text c="dimmed">Nothing waiting for review. Upload a document to create proposals.</Text>
      )}
      {tasks.map((task) => (
        <TaskCard key={task.task_id} task={task} onChanged={reload} />
      ))}

      <Title order={3}>Import records</Title>
      <ImportCard />

      <Title order={3}>Export your record</Title>
      <Card withBorder>
        <Stack gap="xs">
          <Text size="sm">
            You own everything here. Download the complete record as a FHIR R4 bundle (portable to any
            FHIR system) or all observations as CSV.
          </Text>
          <Group>
            <Button variant="light" component="a" href={exportFhirUrl} target="_blank">
              Download FHIR bundle (JSON)
            </Button>
            <Button variant="light" component="a" href={exportCsvUrl} target="_blank">
              Download observations (CSV)
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}

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
    <Card withBorder>
      <Stack gap="xs">
        <Text size="sm">
          Bring history from elsewhere — a <b>FHIR R4 bundle</b> (.json) from a hospital portal, an{' '}
          <b>observations CSV</b> (this app's export format), or an <b>Apple Health</b> export.xml. Imports
          are deterministic: re-importing the same file never duplicates, everything is tagged{' '}
          <code>imported</code> with provenance.
        </Text>
        <Text size="xs" c="dimmed">
          Prefer hands-off? Drop files into <code>data/inbox/</code> — they are imported automatically
          (PDFs/photos go through the review queue).
        </Text>
        <Group align="flex-end">
          <FileInput
            label="File"
            placeholder="Choose .json / .csv / .xml"
            accept=".json,.csv,.xml,application/json,text/csv,text/xml"
            value={file}
            onChange={setFile}
            w={320}
            clearable
          />
          <Button onClick={doImport} loading={busy} disabled={!file}>
            Import
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function TaskCard({ task, onChanged }: { task: ReviewTask; onChanged: () => void }) {
  const medplum = useMedplum();
  const [json, setJson] = useState(() => JSON.stringify(task.resource, null, 2));
  const [busy, setBusy] = useState(false);

  const confidenceColor =
    task.confidence == null ? 'gray' : task.confidence >= 0.8 ? 'teal' : task.confidence >= 0.5 ? 'yellow' : 'red';

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
    <Card withBorder>
      <Stack gap="xs">
        <Group justify="space-between">
          <Group gap="xs">
            <Text fw={600}>{task.description}</Text>
            <Badge color={confidenceColor}>
              {task.confidence == null ? 'confidence n/a' : `confidence ${Math.round(task.confidence * 100)}%`}
            </Badge>
            {task.confidence != null && task.confidence < 0.5 && <Badge color="red">low confidence — check carefully</Badge>}
          </Group>
          <Button size="compact-sm" variant="subtle" onClick={openSource}>
            View source document
          </Button>
        </Group>
        {task.source_excerpt && <Blockquote p="xs">{task.source_excerpt}</Blockquote>}
        <Textarea
          label="Proposed FHIR resource (edit before approving if needed)"
          value={json}
          onChange={(e) => setJson(e.currentTarget.value)}
          autosize
          minRows={4}
          maxRows={16}
          styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
        />
        <Group>
          <Button size="compact-sm" onClick={approve} loading={busy}>
            Approve & commit
          </Button>
          <Button size="compact-sm" variant="light" color="red" onClick={reject} loading={busy}>
            Reject
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
