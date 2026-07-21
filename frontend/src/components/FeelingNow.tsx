/**
 * FeelingNow — the momentary "How am I feeling right now?" check-in
 * (FHIR-MAPPING.md §4 "Momentary feeling checks"): an Overview due-card plus
 * the one-tap capture modal.
 *
 * Architecture: <FeelingNowCard/> is mounted by OverviewPage. Dueness is
 * DERIVED, never stored — the client-local cadence preference (feeling.ts,
 * localStorage) splits the local day into 2/3/4 windows and the card is DUE
 * when the newest `feeling-now` entry predates the current window. The
 * newest entry comes from ONE bounded server-side search (code + _tag +
 * _sort, _count=1 — loadLastFeeling). Cadence 'off' renders nothing; the
 * preference lives on the settings page ("Feeling check-ins").
 *
 * Writes (feeling.ts): 1–2 quick Observations — the SAME local mood/energy
 * codes every dashboard already reads — with meta.tag feeling-now, a
 * quick-observation client-event-UUID identifier, backdatable
 * effectiveDateTime, and the note in Observation.note.
 *
 * Voice + AI (the boundary rules, CLAUDE.md §2/§6):
 * - Dictation uses the BROWSER's Web Speech API. That is a data boundary —
 *   Chrome ships audio to Google's speech service — so an amber
 *   BoundaryRow-style disclosure is shown before first use and whenever the
 *   mic is live. Unsupported browsers simply never see the voice button.
 *   Audio itself is never stored (mapping §4).
 * - "✦ Parse with AI" sends the NOTE TEXT ONLY to the ai-service
 *   (/assistant/parse-feeling) and only when the feeling route is
 *   configured; the engine and its boundary (local green / cloud amber with
 *   the named provider) are always disclosed next to the button. Parsed
 *   values PRE-FILL the controls under the ✦ AI pill + confidence — the
 *   user must press Save themselves (human-in-the-loop; nothing
 *   auto-commits). A 503 "provider not configured" answer renders the
 *   configure state, never a raw error.
 */
import { Modal, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconMicrophone, IconPlayerStopFilled } from '@tabler/icons-react';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { AiRoute, AiSettings } from '../api';
import { getAiSettings, parseFeeling } from '../api';
import type { FeelingCadence } from '../feeling';
import {
  FEELING_CADENCE_LABEL,
  feelingWindow,
  isFeelingDue,
  loadFeelingCadence,
  loadLastFeeling,
  saveFeelingCheck,
} from '../feeling';
import { T, mono } from '../tokens';
import { useIsMobile } from '../useIsMobile';
import {
  AIPill,
  BoundaryRow,
  CardTitle,
  Chip,
  ConfidenceBar,
  DsCard,
  Eyebrow,
  PillButton,
  ScalePills,
  StatusDot,
} from './ds';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Recognizes the ai-service's 503 ProviderNotConfigured detail strings.
 * Keep in sync with AssistantPage's NOT_CONFIGURED_MSG (same service, same
 * error shapes — the client strips the status code, so we match the text). */
const NOT_CONFIGURED_MSG =
  /^503\b|AI Settings|rejected the API key|Ollama not running|No AI provider|Unknown AI provider/i;

/** Once the user has seen the voice boundary disclosure and started the mic,
 * the line only reappears while the mic is actually live. */
const VOICE_SEEN_KEY = 'hmd.voice-disclosure-seen';

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama',
};
const providerLabel = (name: string) => PROVIDER_LABEL[name] ?? name;

/** Current LOCAL time formatted for <input type="datetime-local"> (same
 * timezone-offset shuffle as LogPage's nowLocalInput — toISOString is UTC). */
function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** HH:MM local wall clock. */
function fmtClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function voiceDisclosureSeen(): boolean {
  try {
    return localStorage.getItem(VOICE_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markVoiceDisclosureSeen(): void {
  try {
    localStorage.setItem(VOICE_SEEN_KEY, '1');
  } catch {
    // storage unavailable — the disclosure just keeps showing (safe default)
  }
}

/**
 * Which engine would serve /assistant/parse-feeling right now, judged from
 * AI settings the same way AssistantPage gates its composer: the service
 * routes the momentary-check parse under the `feeling` feature slug
 * (ai-service ai_settings.py FEATURES). Returns undefined when the call
 * would 503 (route off, or cloud without a configured key), which hides the
 * parse affordance entirely — never send data toward an unconfigured
 * provider (CLAUDE.md §6).
 */
function parseEngine(s: AiSettings | undefined): { local: boolean; name: string } | undefined {
  if (!s) {
    return undefined;
  }
  const route: AiRoute | undefined = s.routing.feeling;
  if (route === 'local') {
    return { local: true, name: 'Ollama' };
  }
  if (route === 'cloud') {
    const p = s.providers.find((x) => !x.is_local && x.configured && x.name === s.cloud_provider);
    return p ? { local: false, name: providerLabel(p.name) } : undefined;
  }
  return undefined;
}

/** Categorical model confidence → a bar fraction for ConfidenceBar (display
 * only; the word itself is always shown alongside). */
const CONFIDENCE_FRACTION: Record<'high' | 'medium' | 'low', number> = {
  high: 0.9,
  medium: 0.6,
  low: 0.3,
};

// ---------------------------------------------------------------------------
// Web Speech API (feature-detected; typed minimally — lib.dom has no
// SpeechRecognition types and the Chrome implementation is webkit-prefixed)
// ---------------------------------------------------------------------------

interface SpeechAlternativeLike {
  transcript: string;
}
interface SpeechResultLike {
  isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechAlternativeLike;
}
interface SpeechEventLike {
  results: { readonly length: number; [index: number]: SpeechResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

// ---------------------------------------------------------------------------
// Capture modal
// ---------------------------------------------------------------------------

const fieldLabel: CSSProperties = { ...mono(10, 500, T.quaternary), letterSpacing: '.04em' };

const bandInput = {
  input: {
    background: T.band,
    border: 'none',
    borderRadius: 12,
    fontSize: 13.5,
    color: T.ink,
  } as CSSProperties,
};

const monoBandInput = {
  input: { ...bandInput.input, minHeight: 40, height: 40, fontFamily: T.mono } as CSSProperties,
};

function Field({ label, right, children }: { label: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={fieldLabel}>{label}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function FeelingModal({
  opened,
  onClose,
  onSaved,
}: {
  opened: boolean;
  onClose: () => void;
  /** Called with the saved entry's effectiveDateTime (ISO) so the card can
   * refresh its due state without a refetch. */
  onSaved: (effectiveIso: string) => void;
}) {
  const medplum = useMedplum();
  const isMobile = useIsMobile();

  const [mood, setMood] = useState<number>();
  const [energy, setEnergy] = useState<number>();
  const [note, setNote] = useState('');
  const [when, setWhen] = useState(nowLocalInput());
  const [saving, setSaving] = useState(false);

  // AI parse state. `aiMeta` records WHICH controls are currently showing an
  // unedited parsed value — see the provenance policy note on save() below.
  // `tags` are the server-grounded transcript words: display context only
  // (indigo chips), never saved as coded data — same as the iOS capture.
  const [settings, setSettings] = useState<AiSettings>();
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string>();
  const [needsProvider, setNeedsProvider] = useState(false);
  const [aiMeta, setAiMeta] = useState<{
    mood: boolean;
    energy: boolean;
    confidence: 'high' | 'medium' | 'low';
    tags: string[];
  }>();

  // Voice state
  const speechCtor = useMemo(getSpeechRecognitionCtor, []);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const noteBaseRef = useRef('');
  const [listening, setListening] = useState(false);
  const [disclosureSeen, setDisclosureSeen] = useState(voiceDisclosureSeen);

  // Fresh capture every time the modal opens; the AI-settings probe (for the
  // parse gate + boundary line) runs once per open and fails silently — the
  // parse affordance simply stays hidden while the ai-service is unreachable.
  useEffect(() => {
    if (!opened) {
      return;
    }
    setMood(undefined);
    setEnergy(undefined);
    setNote('');
    setWhen(nowLocalInput());
    setAiMeta(undefined);
    setParseError(undefined);
    setNeedsProvider(false);
    let cancelled = false;
    getAiSettings()
      .then((s) => {
        if (!cancelled) {
          setSettings(s);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSettings(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [opened]);

  // Kill the mic whenever the modal closes/unmounts — never listen unseen.
  useEffect(() => {
    if (!opened && recRef.current) {
      recRef.current.abort();
      recRef.current = null;
      setListening(false);
    }
  }, [opened]);
  useEffect(
    () => () => {
      recRef.current?.abort();
    },
    []
  );

  const startVoice = () => {
    if (!speechCtor || listening) {
      return;
    }
    const rec = new speechCtor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    // Dictation appends after whatever is already typed.
    noteBaseRef.current = note ? `${note.replace(/\s+$/, '')} ` : '';
    rec.onresult = (event) => {
      let finalText = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        const text = r[0]?.transcript ?? '';
        if (r.isFinal) {
          finalText += text;
        } else {
          interim += text;
        }
      }
      setNote(noteBaseRef.current + finalText + interim);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
    // The disclosure was visible up to this first start; from now on it only
    // shows while the mic is live.
    setDisclosureSeen(true);
    markVoiceDisclosureSeen();
  };

  const stopVoice = () => {
    recRef.current?.stop();
    setListening(false);
  };

  const engine = parseEngine(settings);

  const runParse = async () => {
    const text = note.trim();
    if (!text || parsing) {
      return;
    }
    setParsing(true);
    setParseError(undefined);
    try {
      const parsed = await parseFeeling(text);
      // Defensive re-gate of the server's own clamp: only values on the 1–10
      // scale pre-fill — anything else would be outside the instrument.
      const inScale = (v: number | null): number | undefined =>
        v != null && v >= 1 && v <= 10 ? Math.round(v) : undefined;
      const moodVal = inScale(parsed.mood);
      const energyVal = inScale(parsed.energy);
      if (moodVal !== undefined) {
        setMood(moodVal);
      }
      if (energyVal !== undefined) {
        setEnergy(energyVal);
      }
      // The cleaned transcript (content unchanged, dictation filler removed)
      // replaces the raw note — the user sees exactly what will be saved and
      // can still edit it (mirrors the iOS capture screen).
      if (parsed.note.trim()) {
        setNote(parsed.note.trim());
        noteBaseRef.current = '';
      }
      if (moodVal !== undefined || energyVal !== undefined) {
        setAiMeta({
          mood: moodVal !== undefined,
          energy: energyVal !== undefined,
          confidence: parsed.confidence,
          tags: parsed.tags ?? [],
        });
      } else {
        setAiMeta(undefined);
        setParseError('Nothing to pre-fill — the note does not state a mood or energy value.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (NOT_CONFIGURED_MSG.test(msg)) {
        // The structured "configure a provider" case — a state, not an error.
        setNeedsProvider(true);
      } else {
        setParseError(msg);
      }
    } finally {
      setParsing(false);
    }
  };

  // AI-parsed provenance policy (mapping §4): a parser-pre-filled value the
  // user leaves untouched is saved with the ai-parsed tag (the model's
  // reading, confirmed on screen). The moment the user EDITS a control, that
  // value is their own assertion — the flag (and its ✦ AI pill) drops for
  // that value only. Handled here by routing every manual change through
  // these setters, which clear the per-field flag.
  const setMoodByUser = (v: number | undefined) => {
    setMood(v);
    setAiMeta((m) => (m ? { ...m, mood: false } : m));
  };
  const setEnergyByUser = (v: number | undefined) => {
    setEnergy(v);
    setAiMeta((m) => (m ? { ...m, energy: false } : m));
  };

  const save = async () => {
    if (mood === undefined || saving) {
      return;
    }
    setSaving(true);
    const effective = new Date(when).toISOString();
    try {
      await saveFeelingCheck(medplum, {
        mood,
        energy,
        note: note.trim() || undefined,
        effective,
        moodAiParsed: aiMeta?.mood === true,
        energyAiParsed: energy !== undefined && aiMeta?.energy === true,
      });
      notifications.show({ color: 'hmdGreen', message: 'Feeling check saved' });
      onSaved(effective);
      onClose();
    } catch (err) {
      notifications.show({
        color: 'hmdRed',
        title: 'Could not save the check-in',
        message: normalizeErrorString(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const showAi = aiMeta !== undefined && (aiMeta.mood || aiMeta.energy);
  const showDisclosure = speechCtor !== undefined && (listening || !disclosureSeen);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      radius="lg"
      centered
      withCloseButton={false}
      padding={24}
      size={isMobile ? undefined : 480}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Eyebrow>Check-in</Eyebrow>
          <CardTitle size={17}>How am I feeling right now?</CardTitle>
        </div>

        <Field
          label="MOOD · 1–10"
          right={aiMeta?.mood ? <AIPill label="AI" /> : undefined}
        >
          <ScalePills value={mood} onChange={setMoodByUser} />
        </Field>

        <Field
          label="ENERGY · 1–10 · OPTIONAL"
          right={aiMeta?.energy ? <AIPill label="AI" /> : undefined}
        >
          <ScalePills value={energy} onChange={setEnergyByUser} clearable />
        </Field>

        {showAi ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ConfidenceBar
              value={CONFIDENCE_FRACTION[aiMeta.confidence]}
              label="✦ parsed from your note — confirm, edit or Save"
              valueLabel={`confidence ${aiMeta.confidence}`}
            />
            {aiMeta.tags.length > 0 ? (
              // Server-grounded transcript words: context for the reader only —
              // never saved as coded data (matches the iOS capture screen).
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {aiMeta.tags.slice(0, 5).map((tag) => (
                  <Chip key={tag} ai>
                    {tag}
                  </Chip>
                ))}
              </div>
            ) : null}
            <span style={{ fontSize: 11, color: T.quaternary, lineHeight: 1.5 }}>
              Suggestions pre-fill the controls — adjust anything, then Save. An edited value is
              saved as yours, not the AI's.
            </span>
          </div>
        ) : null}

        <Field label="NOTE · OPTIONAL">
          <Textarea
            placeholder="in your own words — type it or dictate it"
            value={note}
            onChange={(e) => {
              setNote(e.currentTarget.value);
              setParseError(undefined);
            }}
            autosize
            minRows={2}
            // While dictating, the recognizer owns this field (base + final +
            // interim); manual edits resume once the mic stops.
            readOnly={listening}
            styles={bandInput}
          />
        </Field>

        {speechCtor ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <PillButton
              variant={listening ? 'destructive-tint' : 'secondary'}
              size={12}
              onClick={listening ? stopVoice : startVoice}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {listening ? (
                <>
                  <IconPlayerStopFilled size={12} /> Stop dictating
                </>
              ) : (
                <>
                  <IconMicrophone size={13} stroke={1.8} /> Dictate
                </>
              )}
            </PillButton>
            {listening ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <StatusDot color={T.outOfRange} size={6} pulse />
                <span style={mono(10.5, 500, T.outOfRange)}>listening…</span>
              </span>
            ) : null}
          </div>
        ) : null}

        {showDisclosure ? (
          <BoundaryRow
            local={false}
            name="Voice uses your browser's speech service"
            detail="audio may leave this device (Chrome sends it to Google)"
          />
        ) : null}

        {needsProvider ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <StatusDot color={T.watch} size={7} />
            <span style={{ fontSize: 12.5, color: T.secondary }}>
              Parsing needs an AI provider — nothing was sent.
            </span>
            <Link
              to="/ai-settings"
              style={{ fontSize: 12.5, fontWeight: 500, color: T.green, textDecoration: 'none' }}
            >
              Configure a provider →
            </Link>
          </div>
        ) : engine && note.trim() ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <PillButton
              size={12.5}
              onClick={() => void runParse()}
              disabled={parsing}
              disabledReason="✦ Parsing…"
              style={{ alignSelf: 'flex-start', background: T.aiBg, color: T.ai, fontWeight: 500 }}
            >
              ✦ Parse with AI
            </PillButton>
            <BoundaryRow
              local={engine.local}
              name={engine.name}
              detail="reads this note's text only — never your record"
            />
          </div>
        ) : null}

        {parseError ? <span style={mono(10.5, 400, T.outOfRange)}>{parseError}</span> : null}

        <Field label="WHEN">
          <TextInput
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.currentTarget.value)}
            styles={monoBandInput}
          />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <PillButton variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </PillButton>
          <PillButton
            variant="primary"
            onClick={() => void save()}
            disabled={mood === undefined || saving}
            disabledReason={saving ? 'Saving…' : mood === undefined ? 'Pick a mood first' : undefined}
          >
            Save check-in
          </PillButton>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Overview card
// ---------------------------------------------------------------------------

/** Amber DUE / green quiet-state tag (same visual language as CheckinPage). */
function DueTag({ due, quiet }: { due: boolean; quiet: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <StatusDot color={due ? T.watch : T.inRange} size={6} />
      <span style={{ ...mono(9.5, 500, due ? T.watch : T.tertiary), letterSpacing: '.06em' }}>
        {due ? 'DUE' : quiet}
      </span>
    </span>
  );
}

/**
 * The Overview "How am I feeling right now?" card. Renders nothing while the
 * cadence preference is off; with a cadence on it shows the DUE state when
 * the current window has no entry and a quiet "logged HH:MM · next HH:MM"
 * line once covered (a spot check can still be logged any time — the button
 * never locks). A 60 s ticker rolls the window over without a reload, same
 * as TodayMedsCard's clock.
 */
export function FeelingNowCard() {
  const medplum = useMedplum();
  const isMobile = useIsMobile();
  // Read once per mount — route changes remount the Overview page, so a
  // cadence flipped on the settings page is picked up on the way back here.
  const [cadence] = useState<FeelingCadence>(loadFeelingCadence);
  const [last, setLast] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (cadence === 'off') {
      return;
    }
    let cancelled = false;
    loadLastFeeling(medplum)
      .then((iso) => {
        if (!cancelled) {
          setLast(iso);
          setLoaded(true);
        }
      })
      .catch(() => {
        // Search failed (offline?) — degrade to "due" rather than hiding the
        // card: an extra prompt is harmless, a silenced one defeats the point.
        if (!cancelled) {
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [medplum, cadence]);

  if (cadence === 'off') {
    return null;
  }

  const due = loaded && isFeelingDue(cadence, last, now);
  const win = feelingWindow(cadence, now);
  const lastDate = last ? new Date(last) : undefined;
  const quiet =
    lastDate && !Number.isNaN(lastDate.getTime())
      ? `LOGGED ${fmtClock(lastDate)}${win ? ` · NEXT ${fmtClock(win.end)}` : ''}`
      : '—';

  return (
    <>
      <DsCard padding="16px 22px" gap={10}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Eyebrow>Check-in</Eyebrow>
          <span style={{ marginLeft: 'auto' }}>{loaded ? <DueTag due={due} quiet={quiet} /> : null}</span>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            alignItems: isMobile ? 'stretch' : 'center',
            gap: isMobile ? 10 : 14,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <CardTitle>How am I feeling right now?</CardTitle>
            <span style={mono(10, 400, T.tertiary)}>
              mood 1–10 · energy optional · {FEELING_CADENCE_LABEL[cadence].toLowerCase()}
            </span>
          </div>
          <PillButton
            variant={due ? 'primary' : 'secondary'}
            onClick={() => setOpen(true)}
            style={
              isMobile
                ? { minHeight: 44, width: '100%' }
                : { marginLeft: 'auto', whiteSpace: 'nowrap' }
            }
          >
            Check in
          </PillButton>
        </div>
      </DsCard>
      <FeelingModal
        opened={open}
        onClose={() => setOpen(false)}
        onSaved={(iso) =>
          // keep the newest clinical time — a backdated save must not hide a
          // newer existing entry
          setLast((prev) =>
            !prev || new Date(iso).getTime() > new Date(prev).getTime() ? iso : prev
          )
        }
      />
    </>
  );
}
