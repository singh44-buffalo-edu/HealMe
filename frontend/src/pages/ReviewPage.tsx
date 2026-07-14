import {
  Alert,
  Button,
  Card,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  Title,
  TypographyStylesProvider,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useState } from 'react';
import type { AiStatus, ReviewResult } from '../api';
import { generateReview, getAiHealth, getLatestReview, reviewPdfUrl } from '../api';

export function ReviewPage() {
  const [ai, setAi] = useState<AiStatus>();
  const [review, setReview] = useState<ReviewResult>();
  const [windowDays, setWindowDays] = useState('90');
  const [generating, setGenerating] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const health = await getAiHealth();
        setAi(health.ai);
      } catch {
        setAi({ provider: null, model: null, configured: false, reason: 'AI service is not reachable — is `make dev` running?' });
      }
      try {
        setReview(await getLatestReview());
      } catch {
        // no review yet — fine
      }
      setLoading(false);
    })();
  }, []);

  const generate = async () => {
    setGenerating(true);
    try {
      const result = await generateReview(Number(windowDays));
      setReview(result);
      notifications.show({ color: 'teal', message: 'Health Review generated' });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Could not generate the review',
        message: err instanceof Error ? err.message : String(err),
        autoClose: 10000,
      });
    } finally {
      setGenerating(false);
    }
  };

  if (loading) return <Loader />;

  return (
    <Stack>
      <Title order={2}>AI Health Review</Title>

      {!ai?.configured && (
        <Alert color="yellow" title="Configure an AI provider to generate reviews">
          <Stack gap={4}>
            <Text size="sm">{ai?.reason}</Text>
            <Text size="sm">
              Set <code>AI_PROVIDER=anthropic</code> and <code>ANTHROPIC_API_KEY=...</code> in the repo{' '}
              <code>.env</code>, then restart <code>make dev</code>. The rest of the app works fine without it.
            </Text>
          </Stack>
        </Alert>
      )}

      {ai?.configured && (
        <Card withBorder>
          <Stack gap="xs">
            <Group>
              <SegmentedControl
                value={windowDays}
                onChange={setWindowDays}
                data={[
                  { label: '30 days', value: '30' },
                  { label: '90 days', value: '90' },
                ]}
              />
              <Button onClick={generate} loading={generating}>
                Generate review
              </Button>
              {generating && (
                <Text size="sm" c="dimmed">
                  Summarizing your record — this can take a minute or two…
                </Text>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              Generating sends aggregated data from your record (medications, adherence, measurements, symptoms,
              labs) to {ai.provider} ({ai.model}). Nothing is sent until you click Generate.
            </Text>
          </Stack>
        </Card>
      )}

      {review ? (
        <Card withBorder>
          <Stack gap="xs">
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                Generated {review.generated_at?.replace('T', ' ').slice(0, 16)}
                {review.description ? ` · ${review.description}` : ''}
              </Text>
              <Button
                size="compact-sm"
                variant="light"
                component="a"
                href={reviewPdfUrl(review.document_reference_id)}
                target="_blank"
              >
                Download PDF
              </Button>
            </Group>
            <TypographyStylesProvider>
              <div
                // AI output rendered as markdown; sanitized before injection
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(marked.parse(review.markdown, { async: false }) as string),
                }}
              />
            </TypographyStylesProvider>
          </Stack>
        </Card>
      ) : (
        <Text c="dimmed">No review yet. {ai?.configured ? 'Generate your first one above.' : ''}</Text>
      )}

      <Text size="xs" c="dimmed">
        Not medical advice — a discussion aid generated from your own records; review it with a qualified
        clinician.
      </Text>
    </Stack>
  );
}
