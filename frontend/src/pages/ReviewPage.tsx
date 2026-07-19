/**
 * ReviewPage — "Health Review": generate and read the visit-prep summary,
 * either AI-drafted or the deterministic data-only variant.
 *
 * Architecture: routed from App.tsx; generation and retrieval go through the
 * Python ai-service (../api), which reads the record, drafts the review, and
 * stores it as DocumentReference + Binary PDF (local type health-review,
 * FHIR-MAPPING.md §2) — the same shape for both variants. This page never
 * writes FHIR directly.
 *
 * Non-negotiable requirements enforced on this surface:
 * - PROVIDER PICKER PER RUN (owner decision, CLAUDE.md §8): every generate
 *   shows an explicit local-vs-cloud choice. The data-only option is ALWAYS
 *   offered and works with no AI key; the AI option is disabled (never
 *   hidden) until a provider is configured, and its BoundaryRow names the
 *   exact recipient (provider + model) — cloud boundaries are amber + named
 *   recipient, never implicit (boundary copy rule, CLAUDE.md §2).
 * - Nothing is sent anywhere until the user clicks Generate, and the copy
 *   says exactly what leaves the machine.
 * - DISCLAIMER: the "Not medical advice — a discussion aid…" line renders on
 *   this page unconditionally and is also baked into every generated PDF by
 *   the service (AI guardrails, CLAUDE.md §6). Reviews organize — they never
 *   diagnose or dose.
 * - AI-labeling: AI-drafted output always carries the ✦ AI pill / indigo
 *   treatment; the data-only summary must NOT (three-data-classes rule).
 */
import { Loader, TypographyStylesProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconPrinter } from '@tabler/icons-react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { AiStatus, ReviewResult } from '../api';
import { normalizeErrorString } from '@medplum/core';
import { downloadReviewPdf, generateDataSummary, generateReview, getAiHealth, getLatestReview } from '../api';
import {
  AIPill,
  BoundaryRow,
  CardTitle,
  DsCard,
  Eyebrow,
  PageHeader,
  PillButton,
  SegmentedPills,
  StatusDot,
} from '../components/ds';
import { T, mono } from '../tokens';

// ---------------------------------------------------------------------------
// Local presentation helpers
// ---------------------------------------------------------------------------

/** Inline code chunk for the .env instructions (mono on band). */
function Code({ children }: { children: ReactNode }) {
  return (
    <code
      style={{
        ...mono(11, 500, T.ink),
        background: T.band,
        borderRadius: 5,
        padding: '1px 5px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </code>
  );
}

/** Selectable wrapper around a BoundaryRow — the per-run provider picker. */
function PickRow({
  selected,
  disabled = false,
  onSelect,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: 'none',
        margin: 0,
        padding: 0,
        font: 'inherit',
        color: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        borderRadius: 12,
        background: selected ? T.band : 'transparent',
      }}
    >
      {children}
    </button>
  );
}

/** Miniature one-pager skeleton (pure divs, per handoff §1-F). */
function DocThumbnail() {
  const bar = (w: string, h: number, bg: string, mt = 0) => (
    <div style={{ width: w, height: h, background: bg, borderRadius: 2, marginTop: mt }} />
  );
  return (
    <div
      style={{
        width: 52,
        height: 68,
        background: T.band,
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '7px 6px',
        boxSizing: 'border-box',
        flexShrink: 0,
      }}
    >
      {bar('70%', 4, '#2a6e52')}
      {bar('100%', 3, '#e0e0dc')}
      {bar('100%', 3, '#e0e0dc')}
      {bar('60%', 3, '#e0e0dc')}
      {bar('100%', 10, '#e9f2ee', 2)}
      {bar('100%', 3, '#e0e0dc')}
    </div>
  );
}

const hairline = <div style={{ height: 1, background: '#f4f4f2', flexShrink: 0 }} />;

// Bounds for the custom review window (days). Presets 30/90 bypass the clamp.
// 90 is the owner-confirmed default window (CLAUDE.md §8); 7/365 are sanity
// bounds, not clinical values.
const CUSTOM_DAYS_MIN = 7;
const CUSTOM_DAYS_MAX = 365;

/** Parse the custom-window input and clamp it to an integer in [7, 365]; NaN if unparseable. */
function clampCustomDays(raw: string): number {
  if (raw.trim() === '') {
    return NaN;
  }
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed)) {
    return NaN;
  }
  return Math.min(CUSTOM_DAYS_MAX, Math.max(CUSTOM_DAYS_MIN, parsed));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Health Review generator + viewer. On mount it fetches AI provider status
 * (unreachable service degrades to the "configure a provider" state, never a
 * crash) and the latest stored review (absence is fine — empty state).
 *
 * FHIR touched (via ai-service): reads the aggregate record for generation;
 * each generate persists a new DocumentReference + PDF Binary. Generation is
 * NOT idempotent — every click produces a new stored review, and the page
 * shows the most recent one. Failure modes: generation errors surface as a
 * notification with the service's reason; the previous review stays visible.
 */
export function ReviewPage() {
  const [ai, setAi] = useState<AiStatus>();
  const [review, setReview] = useState<ReviewResult>();
  const [windowDays, setWindowDays] = useState('90');
  const [customDays, setCustomDays] = useState('');
  const [mode, setMode] = useState<'ai' | 'data'>('data');
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

  // Effective window: 30/90 straight through, custom parsed from the input and
  // clamped to an integer in [7, 365] before it can ever reach the request.
  const effectiveDays = windowDays === 'custom' ? clampCustomDays(customDays) : Number(windowDays);
  const daysValid = Number.isFinite(effectiveDays);

  /** Kick off a generation run of the picked kind. `kind` is passed
   * explicitly (not read from state) so the button always generates exactly
   * what its label promised at click time. */
  const generate = async (kind: 'ai' | 'data') => {
    if (!daysValid) {
      return;
    }
    // Show exactly what is being sent: sync the input to the clamped value.
    if (windowDays === 'custom' && customDays !== String(effectiveDays)) {
      setCustomDays(String(effectiveDays));
    }
    setGenerating(true);
    try {
      const result =
        kind === 'ai'
          ? await generateReview(effectiveDays)
          : await generateDataSummary(effectiveDays);
      setReview(result);
      notifications.show({
        color: 'teal',
        message: kind === 'ai' ? 'Health Review generated' : 'Data-only summary generated',
      });
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

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '64px 0' }}>
        <Loader size="sm" color={T.green} />
      </div>
    );
  }

  // --- derived, all from real review metadata (never fabricated) ------------
  // The service stamps every markdown header: "data-only (no AI)" for local
  // summaries, "provider: name (model)" for AI runs. Unknown ⇒ label as AI.
  const dataOnly = review
    ? /data-only \(no AI\)/.test(review.markdown ?? '') || /no AI/i.test(review.description ?? '')
    : false;
  const generatedAt = review?.generated_at?.replace('T', ' ').slice(0, 16);
  const descWindow = review?.description?.match(/last (\d+) days/);
  const reviewWindow = review?.window_days ?? (descWindow ? Number(descWindow[1]) : undefined);
  const providerLine = !dataOnly ? review?.markdown?.match(/provider:\s*([^\n]+)/)?.[1]?.trim() : undefined;
  const headline =
    review?.description ||
    (dataOnly ? 'Data summary (no AI)' : 'AI Health Review') +
      (reviewWindow ? ` — last ${reviewWindow} days` : '');
  const aiSelectable = ai?.configured === true;
  // fetch → blob (not an href): the PDF endpoint needs the session token.
  const printPdf = review
    ? () =>
        downloadReviewPdf(review.document_reference_id).catch((err) =>
          notifications.show({ color: 'hmdRed', message: normalizeErrorString(err) })
        )
    : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Health Review"
        subtitle={
          <>
            visit prep · a discussion aid from your own records ·{' '}
            {review ? `latest generated ${generatedAt}` : 'no review yet'}
          </>
        }
        right={
          printPdf ? (
            <button
              type="button"
              onClick={printPdf}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 12.5,
                fontWeight: 500,
                color: T.secondary,
                background: T.band,
                borderRadius: 18,
                padding: '8px 16px',
                whiteSpace: 'nowrap',
              }}
            >
              <IconPrinter size={14} stroke={1.7} />
              Print one-pager
            </button>
          ) : undefined
        }
      />

      {/* ------------------------------------------------ generate controls */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {!ai?.configured && (
          <DsCard padding="18px 22px" gap={8}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <StatusDot color={T.watch} size={8} />
              <CardTitle size={14}>
                AI review needs a provider — the data-only summary below works without one
              </CardTitle>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12.5, lineHeight: 1.6, color: T.secondary }}>{ai?.reason}</span>
              <span style={{ fontSize: 12.5, lineHeight: 1.6, color: T.secondary }}>
                Set <Code>AI_PROVIDER=anthropic</Code> and <Code>ANTHROPIC_API_KEY=...</Code> in the repo{' '}
                <Code>.env</Code>, then restart <Code>make dev</Code>. The rest of the app works fine
                without it.
              </span>
            </div>
          </DsCard>
        )}

        <DsCard padding="20px 24px" gap={14}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <CardTitle>Generate a review</CardTitle>
            <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>
              {daysValid ? `window · ${effectiveDays} days` : 'window · —'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <Eyebrow>Review window</Eyebrow>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <SegmentedPills
                options={[
                  { value: '90', label: '90 days' },
                  { value: '30', label: '30 days' },
                  { value: 'custom', label: 'custom' },
                ]}
                value={windowDays}
                onChange={setWindowDays}
              />
              {windowDays === 'custom' && (
                <>
                  <input
                    value={customDays}
                    onChange={(e) => setCustomDays(e.target.value)}
                    placeholder="60"
                    inputMode="numeric"
                    aria-label="custom window in days"
                    style={{
                      ...mono(11.5, 500, T.ink),
                      width: 52,
                      border: `1px solid ${T.hairline}`,
                      borderRadius: 12,
                      padding: '5px 10px',
                      outline: 'none',
                      background: '#ffffff',
                    }}
                  />
                  <span style={mono(10, 400, T.quaternary)}>days</span>
                </>
              )}
            </div>
          </div>

          {/* Per-run provider picker (owner decision §8). Data-only is always
              selectable; the AI row is disabled-but-visible when unconfigured
              so the local path is never the hidden default. The line under the
              rows restates the boundary in words before anything is sent. */}
          <div role="radiogroup" aria-label="provider" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <Eyebrow>Provider — choose per run</Eyebrow>
            <PickRow selected={mode === 'data'} onSelect={() => setMode('data')}>
              <BoundaryRow
                local
                name="Data-only summary (no AI)"
                detail="computed from your record on this machine"
              />
            </PickRow>
            <PickRow
              selected={mode === 'ai'}
              disabled={!aiSelectable}
              onSelect={() => setMode('ai')}
            >
              <BoundaryRow
                local={false}
                name="AI review"
                detail={
                  aiSelectable ? `${ai?.provider} (${ai?.model})` : 'no provider configured'
                }
              />
            </PickRow>
            <span style={mono(10.5, 400, mode === 'ai' ? T.watch : T.tertiary)}>
              {mode === 'ai'
                ? 'selected: AI review — aggregated data leaves this machine when you click Generate'
                : 'selected: data-only — nothing leaves this machine'}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <PillButton
              variant="primary"
              onClick={() => generate(mode)}
              disabled={generating || !daysValid || (mode === 'ai' && !aiSelectable)}
              disabledReason={
                generating ? 'Generating…' : !daysValid ? 'enter a window in days' : undefined
              }
            >
              {mode === 'ai' ? 'Generate AI review' : 'Generate data-only summary'}
            </PillButton>
            {generating && (
              <span style={mono(11, 400, T.tertiary)}>
                Working — the AI review can take a minute or two…
              </span>
            )}
          </div>

          {hairline}

          <span style={{ fontSize: 11.5, lineHeight: 1.6, color: T.secondary }}>
            The data-only summary never leaves your machine.
            {ai?.configured &&
              ` Generating the AI review sends aggregated data from your record (medications, adherence, measurements, symptoms, labs) to ${ai.provider} (${ai.model}) — nothing is sent until you click Generate.`}{' '}
            Questions saved under Quick add → "Question for your clinician" are included in both.
          </span>
        </DsCard>
      </section>

      {/* ------------------------------------------------- generated review */}
      {review ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* the one answer first — dark hero band */}
          <DsCard
            dark
            padding="20px 26px"
            gap={0}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}
          >
            <StatusDot color={T.liveAccent} size={10} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  letterSpacing: '-.015em',
                  color: '#f5f5f4',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 9,
                }}
              >
                {headline}
                {!dataOnly && <AIPill />}
              </span>
              <span style={mono(11, 400, '#98989d')}>
                generated {generatedAt}
                {reviewWindow ? ` · window ${reviewWindow} days` : ''}
              </span>
            </div>
            <span
              style={{
                marginLeft: 'auto',
                ...mono(10, 400, '#636366'),
                textAlign: 'right',
                flexShrink: 0,
              }}
            >
              {dataOnly
                ? 'data-only · no AI involved'
                : reviewWindow
                  ? `drafted by ✦ from ${reviewWindow} days`
                  : 'drafted by ✦'}
            </span>
          </DsCard>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.4fr 1fr',
              gap: 16,
              alignItems: 'start',
            }}
          >
            {/* review body */}
            <DsCard ai={!dataOnly} padding="20px 24px" gap={12}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {!dataOnly && <AIPill />}
                <span style={mono(10.5, 400, T.tertiary)}>generated {generatedAt}</span>
                {printPdf && (
                  <button
                    type="button"
                    onClick={printPdf}
                    style={{
                      marginLeft: 'auto',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: T.green,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <IconDownload size={14} stroke={1.7} />
                    Download PDF
                  </button>
                )}
              </div>
              {hairline}
              <TypographyStylesProvider>
                <div
                  style={{ fontSize: 13.5, lineHeight: 1.65, color: T.ink }}
                  // AI output rendered as markdown; sanitized before injection
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(marked.parse(review.markdown ?? '', { async: false }) as string, {
                      // AI output must not load remote resources (tracking/exfil channel)
                      FORBID_TAGS: ['img', 'svg', 'iframe', 'object', 'embed'],
                    }),
                  }}
                />
              </TypographyStylesProvider>
            </DsCard>

            {/* right rail */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <DsCard padding="18px 22px" gap={11}>
                <CardTitle size={14}>About this review</CardTitle>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...mono(10.5, 400, T.tertiary) }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <span>generated</span>
                    <span style={{ color: T.ink }}>{generatedAt}</span>
                  </div>
                  {reviewWindow ? (
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <span>window</span>
                      <span style={{ color: T.ink }}>{reviewWindow} days</span>
                    </div>
                  ) : null}
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                    <span>source</span>
                    {dataOnly ? <span style={{ color: T.ink }}>computed locally · no AI</span> : <AIPill />}
                  </div>
                  {providerLine ? (
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <span>provider</span>
                      <span style={{ color: T.ink }}>{providerLine}</span>
                    </div>
                  ) : null}
                </div>
              </DsCard>

              <DsCard
                padding="16px 22px"
                gap={0}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}
              >
                <DocThumbnail />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-.01em' }}>
                    The paper version
                  </span>
                  <span style={{ ...mono(10.5, 400, T.tertiary), lineHeight: 1.5 }}>
                    the full review as one clean PDF · for the desk between you
                  </span>
                </div>
                {printPdf && (
                  <button
                    type="button"
                    onClick={printPdf}
                    style={{
                      marginLeft: 'auto',
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 12.5,
                      fontWeight: 500,
                      whiteSpace: 'nowrap',
                      color: T.green,
                    }}
                  >
                    Download →
                  </button>
                )}
              </DsCard>
            </div>
          </div>
        </section>
      ) : (
        <DsCard padding="30px 24px" gap={0} style={{ alignItems: 'center' }}>
          <span style={mono(12, 400, T.quaternary)}>
            No review yet. {ai?.configured ? 'Generate your first one above.' : ''}
          </span>
        </DsCard>
      )}

      {/* Mandatory disclaimer (CLAUDE.md §6) — renders on every state of this
          page, review or not. Do not make it conditional. */}
      <span style={mono(10, 400, T.quaternary)}>
        Not medical advice — a discussion aid generated from your own records; review it with a qualified
        clinician.
      </span>
    </div>
  );
}
