import { TypographyStylesProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconHistory, IconTrash } from '@tabler/icons-react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { AiSettings, AssistantAnswer, AssistantCitation, AssistantSession } from '../api';
import { askAssistant, deleteAssistantSession, getAiSettings, listAssistantSessions } from '../api';
import {
  AIPill,
  CardTitle,
  DsCard,
  PageHeader,
  PillButton,
  StatusDot,
  TableRow,
} from '../components/ds';
import { T, mono } from '../tokens';
import { useIsMobile } from '../useIsMobile';

/** Mobile shell: floating pill tab bar clearance (tab height + its bottom offset). */
const MOBILE_TAB_BAR_CLEARANCE = 'calc(84px + env(safe-area-inset-bottom))';

// ---------------------------------------------------------------------------
// Local presentation helpers
// ---------------------------------------------------------------------------

/** Sanitized markdown body (same marked + DOMPurify pattern as ReviewPage). */
function AnswerMarkdown({ markdown }: { markdown: string }) {
  return (
    <TypographyStylesProvider>
      <div
        style={{ fontSize: 14, lineHeight: 1.65, letterSpacing: '-.01em', color: T.ink }}
        // AI output rendered as markdown; sanitized before injection
        dangerouslySetInnerHTML={{
          __html: DOMPurify.sanitize(marked.parse(markdown ?? '', { async: false }) as string, {
            // AI output must not load remote resources (tracking/exfil channel)
            FORBID_TAGS: ['img', 'svg', 'iframe', 'object', 'embed'],
          }),
        }}
      />
    </TypographyStylesProvider>
  );
}

const citeChipStyle = {
  ...mono(10, 500, T.ai),
  background: T.aiBg,
  borderRadius: 10,
  padding: '1px 7px',
  textDecoration: 'none',
  flexShrink: 0,
} as const;

/** Numbered citation chip — scrolls to its row in the SOURCES list. */
function CiteChip({ n, targetId }: { n: number; targetId: string }) {
  return (
    <a
      href={`#${targetId}`}
      onClick={(e) => {
        e.preventDefault();
        document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }}
      style={citeChipStyle}
    >
      {n}
    </a>
  );
}

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const fmtStamp = (iso: string): string => iso.replace('T', ' ').slice(0, 16);

const citeId = (commId: string, n: number): string => `assistant-cite-${commId}-${n}`;

/** Can an ask succeed right now, judged from AI settings? Route off / cloud
 * without a configured key means the service will answer 503 — show the
 * configure state instead of a doomed composer. Local routes always build
 * (runtime failures surface as regular errors). */
function assistantReady(s: AiSettings): boolean {
  const route = s.routing.assistant;
  if (route === 'off') {
    return false;
  }
  if (route === 'local') {
    return true;
  }
  return s.providers.some((p) => !p.is_local && p.configured && p.name === s.cloud_provider);
}

/** The ai-service client surfaces HTTP errors as their detail string (the
 * status code is stripped), so a 503 ProviderNotConfigured is recognized by
 * its known message shapes as well as by a bare "503 …" fallback. */
const NOT_CONFIGURED_MSG =
  /^503\b|AI Settings|rejected the API key|Ollama not running|No AI provider|Unknown AI provider/i;

const SUGGESTIONS = [
  'Summarize my last 90 days',
  'How is my medication adherence?',
  'What changed in my recent labs?',
];

interface Exchange {
  key: number;
  question: string;
  answer?: AssistantAnswer;
}

// ---------------------------------------------------------------------------
// Message bubbles
// ---------------------------------------------------------------------------

function UserBubble({ question }: { question: string }) {
  const isMobile = useIsMobile();
  return (
    <div
      style={{
        alignSelf: 'flex-end',
        maxWidth: isMobile ? '88%' : 520,
        background: T.ink,
        color: '#f5f5f4',
        borderRadius: '18px 18px 4px 18px',
        padding: '12px 18px',
        fontSize: 14,
        lineHeight: 1.5,
        letterSpacing: '-.01em',
        whiteSpace: 'pre-wrap',
      }}
    >
      {question}
    </div>
  );
}

function AssistantAvatar() {
  return (
    <span
      style={{
        width: 26,
        height: 26,
        borderRadius: '50%',
        background: T.green,
        color: '#fff',
        display: 'grid',
        placeItems: 'center',
        fontSize: 12,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      H
    </span>
  );
}

function SourcesList({ commId, citations }: { commId: string; citations: AssistantCitation[] }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        borderTop: '1px solid #f4f4f2',
        paddingTop: 12,
      }}
    >
      <span style={{ ...mono(9.5, 500, T.quaternary), letterSpacing: '.1em' }}>SOURCES</span>
      {citations.map((c) => (
        <div
          key={c.n}
          id={citeId(commId, c.n)}
          style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: T.secondary }}
        >
          <span style={citeChipStyle}>{c.n}</span>
          <span style={{ fontWeight: 500, color: T.ink }}>{c.display}</span>
          <span style={mono(10, 400, T.quaternary)}>
            {[c.resourceType, c.value, c.date].filter(Boolean).join(' · ')}
          </span>
        </div>
      ))}
    </div>
  );
}

function AssistantBubble({ answer }: { answer: AssistantAnswer }) {
  const isMobile = useIsMobile();
  const local = answer.provider.is_local;
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: isMobile ? '96%' : 640,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <AssistantAvatar />
        <AIPill />
        <span style={mono(9.5, 400, T.quaternary)}>
          read {answer.read_count} observations ·{' '}
          {local ? (
            'processed locally'
          ) : (
            <span style={{ color: T.watch }}>sent to {cap(answer.provider.name)} — leaves device</span>
          )}
        </span>
      </div>
      <div
        style={{
          background: T.card,
          borderRadius: '4px 18px 18px 18px',
          padding: '18px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          boxShadow: T.shadowCard,
        }}
      >
        <AnswerMarkdown markdown={answer.answer_markdown} />
        {answer.citations.length > 0 ? (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {answer.citations.map((c) => (
                <CiteChip key={c.n} n={c.n} targetId={citeId(answer.communication_id, c.n)} />
              ))}
            </div>
            <SourcesList commId={answer.communication_id} citations={answer.citations} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function PendingBubble() {
  return (
    <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 8 }}>
      <AssistantAvatar />
      <AIPill />
      <StatusDot color={T.ai} size={6} pulse />
      <span style={mono(9.5, 400, T.quaternary)}>reading your record…</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AssistantPage() {
  const isMobile = useIsMobile();
  const [settings, setSettings] = useState<AiSettings>();
  const [needsProvider, setNeedsProvider] = useState(false);
  const [providerReason, setProviderReason] = useState<string>();
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [pending, setPending] = useState(false);
  const [input, setInput] = useState('');
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const s = await getAiSettings();
        setSettings(s);
        setNeedsProvider(!assistantReady(s));
      } catch {
        // service unreachable — leave the composer up; an ask surfaces the reachability error
      }
      try {
        setSessions(await listAssistantSessions());
      } catch {
        // no history available — fine
      }
    })();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    if (isMobile) {
      // mobile: the page itself scrolls (no inner scroll container)
      window.scrollTo(0, document.documentElement.scrollHeight);
    }
  }, [exchanges, pending, isMobile]);

  const refreshSettings = async (): Promise<boolean> => {
    try {
      const s = await getAiSettings();
      setSettings(s);
      const ready = assistantReady(s);
      setNeedsProvider(!ready);
      if (ready) {
        setProviderReason(undefined);
      }
      return ready;
    } catch {
      return true; // can't tell — don't lock the composer on a blip
    }
  };

  const ask = async (raw: string) => {
    const question = raw.trim();
    if (!question || pending) {
      return;
    }
    setInput('');
    keyRef.current += 1;
    const key = keyRef.current;
    setExchanges((xs) => [...xs, { key, question }]);
    setPending(true);
    try {
      const answer = await askAssistant(question);
      setExchanges((xs) => xs.map((x) => (x.key === key ? { ...x, answer } : x)));
      listAssistantSessions().then(setSessions).catch(() => {});
    } catch (err) {
      // failed — drop the bubble and hand the question back for a retry
      setExchanges((xs) => xs.filter((x) => x.key !== key));
      setInput(question);
      const msg = err instanceof Error ? err.message : String(err);
      // A 503 (provider not configured / turned off) flips to the configure state.
      const unconfigured = NOT_CONFIGURED_MSG.test(msg);
      const ready = await refreshSettings();
      if (!ready || unconfigured) {
        setProviderReason(unconfigured ? msg : undefined);
        setNeedsProvider(true);
      } else {
        notifications.show({
          color: 'hmdRed',
          title: 'The assistant could not answer',
          message: msg,
          autoClose: 10000,
        });
      }
    } finally {
      setPending(false);
    }
  };

  const doDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteAssistantSession(id);
      setSessions((xs) => xs.filter((s) => s.id !== id));
      notifications.show({
        color: 'hmdGreen',
        message: 'Conversation deleted — a note that it was removed stays in your history',
      });
    } catch (err) {
      notifications.show({
        color: 'hmdRed',
        title: 'Could not delete',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeletingId(undefined);
      setConfirmingId(undefined);
    }
  };

  // --- boundary derived from settings (per-answer meta uses the answer itself)
  const route = settings?.routing.assistant;
  const cloud = route === 'cloud';
  const boundaryName = cloud
    ? (settings?.cloud_provider ?? 'cloud')
    : (settings?.providers.find((p) => p.is_local)?.name ?? 'ollama');

  const lastDisclaimer = [...exchanges].reverse().find((x) => x.answer)?.answer?.disclaimer;
  const footerText = `${lastDisclaimer ?? 'Not medical advice.'} The assistant reads your record; it never writes to it.`;

  const emptyChat = exchanges.length === 0 && !pending;

  // Data-boundary chip — desktop keeps it in the header; mobile moves it below
  // the title so the 390px header row never overflows.
  const providerChip =
    settings && route !== 'off' && !needsProvider ? (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          border: `1px solid ${cloud ? '#f3e3c8' : T.chip}`,
          borderRadius: 20,
          padding: '6px 13px',
          background: cloud ? '#fdf9f1' : T.card,
        }}
      >
        <StatusDot color={cloud ? T.watch : T.inRange} size={7} />
        <span style={{ fontSize: 12, fontWeight: 500 }}>
          {cloud ? 'Cloud AI' : 'Local AI'} · {cap(boundaryName)}
        </span>
        <span style={mono(9.5, 400, cloud ? T.watch : T.quaternary)}>
          {cloud ? 'leaves device' : 'stays home'}
        </span>
      </span>
    ) : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        // clear the floating mobile tab bar for in-flow content
        paddingBottom: isMobile ? 'calc(120px + env(safe-area-inset-bottom))' : undefined,
      }}
    >
      <PageHeader
        title="Assistant"
        subtitle="answers come only from your record · every claim cites its source"
        right={
          <>
            {isMobile ? null : providerChip}
            <PillButton
              variant="secondary"
              onClick={() => setHistoryOpen((o) => !o)}
              style={isMobile ? { minHeight: 44, padding: '10px 16px' } : undefined}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <IconHistory size={14} stroke={1.7} />
                History
                {sessions.length > 0 ? (
                  <span style={mono(10.5, 500, T.quaternary)}>{sessions.length}</span>
                ) : null}
              </span>
            </PillButton>
          </>
        }
      />
      {isMobile && providerChip ? <div style={{ display: 'flex' }}>{providerChip}</div> : null}

      {historyOpen ? (
        <DsCard flush>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '16px 22px 10px' }}>
            <CardTitle size={14}>Past questions</CardTitle>
            <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>
              deleting removes the answer · a note that it was removed stays in your history
            </span>
          </div>
          {sessions.length === 0 ? (
            <div style={{ padding: '0 22px 18px' }}>
              <span style={mono(11, 400, T.quaternary)}>No saved questions yet.</span>
            </div>
          ) : (
            sessions.map((s, i) => (
              <TableRow
                key={s.id}
                first={i === 0}
                columns={isMobile ? 'minmax(0,1fr) auto' : 'minmax(0,1fr) auto auto'}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      letterSpacing: '-.01em',
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {s.question}
                  </span>
                  <span
                    style={{
                      ...mono(10.5, 400, T.quaternary),
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {s.answer_preview}
                  </span>
                  {isMobile ? (
                    <span style={mono(10.5, 400, T.tertiary)}>{fmtStamp(s.sent)}</span>
                  ) : null}
                </div>
                {isMobile ? null : <span style={mono(10.5, 400, T.tertiary)}>{fmtStamp(s.sent)}</span>}
                {confirmingId === s.id ? (
                  <div
                    style={
                      isMobile
                        ? { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }
                        : { display: 'flex', alignItems: 'center', gap: 8 }
                    }
                  >
                    <span style={mono(10.5, 400, T.outOfRange)}>delete this conversation?</span>
                    <PillButton
                      variant="destructive-tint"
                      onClick={() => doDelete(s.id)}
                      disabled={deletingId === s.id}
                      disabledReason="Deleting…"
                      style={isMobile ? { minHeight: 44 } : undefined}
                    >
                      Delete
                    </PillButton>
                    <PillButton
                      variant="ghost"
                      onClick={() => setConfirmingId(undefined)}
                      style={isMobile ? { minHeight: 44 } : undefined}
                    >
                      Keep
                    </PillButton>
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label="Delete this conversation"
                    onClick={() => setConfirmingId(s.id)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      color: T.quaternary,
                      display: 'grid',
                      placeItems: 'center',
                      padding: isMobile ? 13 : 4,
                    }}
                  >
                    <IconTrash size={15} stroke={1.7} />
                  </button>
                )}
              </TableRow>
            ))
          )}
        </DsCard>
      ) : null}

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: isMobile || (needsProvider && emptyChat) ? undefined : 'calc(100vh - 250px)',
          minHeight: isMobile || (needsProvider && emptyChat) ? undefined : 420,
        }}
      >
        {/* messages — desktop scrolls independently of the page; mobile flows with
            the page and leaves clearance for the fixed composer + tab bar */}
        <div
          ref={scrollRef}
          style={
            isMobile
              ? {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 18,
                  padding: needsProvider ? '2px 2px 20px' : '2px 2px 96px',
                }
              : {
                  flex: 1,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 18,
                  padding: '2px 2px 20px',
                }
          }
        >
          {emptyChat && !needsProvider ? (
            <>
              <DsCard padding="30px 24px" gap={0} style={{ alignItems: 'center' }}>
                <span style={mono(12, 400, T.quaternary)}>
                  No questions yet — every answer cites the records it came from.
                </span>
              </DsCard>
              <div style={{ marginTop: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => ask(s)}
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      fontFamily: 'inherit',
                      color: T.green,
                      background: 'transparent',
                      border: '1px solid #cfe5dc',
                      borderRadius: 20,
                      padding: isMobile ? '12px 16px' : '8px 16px',
                      minHeight: isMobile ? 44 : undefined,
                      cursor: 'pointer',
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {exchanges.map((x) => (
            <div key={x.key} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <UserBubble question={x.question} />
              {x.answer ? <AssistantBubble answer={x.answer} /> : pending ? <PendingBubble /> : null}
            </div>
          ))}
        </div>

        {/* composer — or the configure state when the service would answer 503 */}
        {needsProvider ? (
          <DsCard padding="26px 24px" gap={10} style={{ alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <StatusDot color={T.watch} size={8} />
              <CardTitle size={14}>The assistant needs an AI provider</CardTitle>
            </div>
            <span style={{ fontSize: 12.5, lineHeight: 1.6, color: T.secondary }}>
              Answers are drafted by an AI model reading your record. Turn the assistant on and pick
              a provider — local stays on this machine; cloud sends your question and record context
              to the provider you choose. Nothing is sent until you ask.
            </span>
            {providerReason ? (
              <span style={mono(10.5, 400, T.watch)}>{providerReason}</span>
            ) : null}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Link
                to="/ai-settings"
                style={{ fontSize: 12.5, fontWeight: 500, color: T.green, textDecoration: 'none' }}
              >
                Configure a provider →
              </Link>
              <PillButton variant="ghost" onClick={refreshSettings}>
                Check again
              </PillButton>
            </div>
          </DsCard>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(input);
            }}
            style={
              isMobile
                ? {
                    // thumb-reach composer: pinned just above the floating tab bar
                    position: 'fixed',
                    left: 16,
                    right: 16,
                    bottom: MOBILE_TAB_BAR_CLEARANCE,
                    zIndex: 10,
                  }
                : undefined
            }
          >
            <div
              style={{
                background: T.card,
                borderRadius: 22,
                padding: isMobile ? '8px 10px 8px 16px' : '10px 12px 10px 20px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                boxShadow: '0 1px 2px rgba(0,0,0,.04), 0 12px 36px rgba(0,0,0,.08)',
                minHeight: isMobile ? 52 : undefined,
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about your health record…"
                aria-label="Ask about your health record"
                disabled={pending}
                style={{
                  flex: 1,
                  border: 'none',
                  outline: 'none',
                  fontSize: 14,
                  fontFamily: 'inherit',
                  color: T.ink,
                  background: 'transparent',
                  minWidth: 0,
                }}
              />
              {settings && route !== 'off' ? (
                <span style={{ ...mono(9.5, 400, cloud ? T.watch : T.quaternary), whiteSpace: 'nowrap' }}>
                  {isMobile
                    ? cloud
                      ? '⚠ leaves device'
                      : '⌂ on device'
                    : cloud
                      ? '⚠ questions leave this device'
                      : '⌂ stays on this device'}
                </span>
              ) : null}
              <PillButton
                variant="primary"
                type="submit"
                disabled={pending || !input.trim()}
                disabledReason={pending ? 'Asking…' : undefined}
                style={isMobile ? { minHeight: 44, padding: '11px 18px' } : undefined}
              >
                Ask
              </PillButton>
            </div>
            {isMobile ? (
              <p
                style={{
                  margin: '8px auto 0',
                  ...mono(10, 400, T.quaternary),
                  textAlign: 'center',
                  width: 'fit-content',
                  maxWidth: '100%',
                  background: 'rgba(239,239,237,.88)',
                  backdropFilter: 'blur(6px)',
                  borderRadius: 10,
                  padding: '3px 10px',
                }}
              >
                {footerText}
              </p>
            ) : null}
          </form>
        )}

        {isMobile && !needsProvider ? null : (
          <p style={{ margin: '10px 4px 0', ...mono(10, 400, T.quaternary), textAlign: 'center' }}>
            {footerText}
          </p>
        )}
      </div>
    </div>
  );
}
