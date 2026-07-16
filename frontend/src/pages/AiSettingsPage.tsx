import { Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCloud, IconHome } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { AiFeature, AiProviderInfo, AiRoute, AiSettings, AiTestResult } from '../api';
import { deleteAiKey, getAiSettings, putAiSettings, setAiKey, testAiProvider } from '../api';
import { AIPill, CardTitle, DsCard, PageHeader, PillButton, StatusDot } from '../components/ds';
import { T, mono } from '../tokens';

// ---------------------------------------------------------------------------
// Constants & copy
// ---------------------------------------------------------------------------

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama',
};

const label = (name: string) => PROVIDER_LABEL[name] ?? name;

/** The four routable features — human words on the surface, slugs on the wire. */
const FEATURES: { slug: AiFeature; name: string; scope: string }[] = [
  { slug: 'health-review', name: 'Health review', scope: 'visit prep · narrative summary of your record' },
  { slug: 'ingest-extraction', name: 'Document extraction', scope: 'scans and photos → values' },
  { slug: 'assistant', name: 'Assistant', scope: 'reads your record, never writes' },
  { slug: 'nl-import', name: 'Quick capture', scope: 'plain sentences → entries for your review' },
];

// ---------------------------------------------------------------------------
// Local presentation helpers
// ---------------------------------------------------------------------------

/** Inline code chunk for .env instructions (mono on band). */
function Code({ children }: { children: ReactNode }) {
  return (
    <code
      style={{
        ...mono(10, 500, T.ink),
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

/** 36×36 rounded icon tile for the provider card headers. */
function IconTile({ bg, color, children }: { bg: string; color: string; children: ReactNode }) {
  return (
    <span
      style={{
        width: 36,
        height: 36,
        borderRadius: 11,
        background: bg,
        color,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

/** mono key/value line inside a card detail block. */
function DetailRow({ k, v, vColor = T.ink }: { k: string; v: ReactNode; vColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span>{k}</span>
      <span style={{ color: vColor, textAlign: 'right' }}>{v}</span>
    </div>
  );
}

/** Detail block: hairline-topped stack of DetailRows (design's usage table). */
function DetailBlock({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        ...mono(11, 400, T.tertiary),
        borderTop: `1px solid ${T.band}`,
        paddingTop: 12,
      }}
    >
      {children}
    </div>
  );
}

/** Connectivity-test outcome line: "✓ Valid · 812ms" or the failure reason. */
function TestOutcome({ state }: { state?: { testing: boolean; result?: AiTestResult } }) {
  if (!state) {
    return null;
  }
  if (state.testing) {
    return <span style={mono(10.5, 400, T.tertiary)}>testing — a tiny no-data probe…</span>;
  }
  if (!state.result) {
    return null;
  }
  if (state.result.ok) {
    return (
      <span style={mono(10.5, 500, T.inRange)}>
        ✓ Valid{state.result.latency_ms !== undefined ? ` · ${state.result.latency_ms}ms` : ''}
        {state.result.model ? ` · ${state.result.model}` : ''}
      </span>
    );
  }
  return (
    <span style={{ ...mono(10.5, 400, T.outOfRange), lineHeight: 1.5 }}>
      ✕ {state.result.reason ?? 'test failed'}
    </span>
  );
}

/** Per-feature engine picker: ⌂ local (green) / ☁ your key (amber) / off. */
function RouteSegment({
  value,
  onChange,
  busy,
}: {
  value: AiRoute;
  onChange: (r: AiRoute) => void;
  busy: boolean;
}) {
  const options: { value: AiRoute; text: string; activeFg: string }[] = [
    { value: 'local', text: '⌂ local', activeFg: T.green },
    { value: 'cloud', text: '☁ your key', activeFg: T.watch },
    { value: 'off', text: 'off', activeFg: T.secondary },
  ];
  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        background: T.chip,
        borderRadius: 18,
        padding: 2,
        justifySelf: 'start',
        opacity: busy ? 0.6 : 1,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={busy}
            onClick={() => onChange(o.value)}
            style={{
              border: 'none',
              cursor: busy ? 'default' : 'pointer',
              ...mono(10.5, 500, active ? o.activeFg : T.tertiary),
              padding: '5px 13px',
              borderRadius: 14,
              background: active ? '#ffffff' : 'transparent',
              boxShadow: active ? T.shadowSegment : undefined,
              whiteSpace: 'nowrap',
            }}
          >
            {o.text}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type TestState = Record<string, { testing: boolean; result?: AiTestResult }>;

export function AiSettingsPage() {
  const [settings, setSettings] = useState<AiSettings>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();

  // which cloud provider the picker shows / the cloud rows use
  const [selProvider, setSelProvider] = useState('anthropic');
  const [switching, setSwitching] = useState(false);

  const [keyDraft, setKeyDraft] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [tests, setTests] = useState<TestState>({});
  const [savingRoute, setSavingRoute] = useState<AiFeature | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const s = await getAiSettings();
      setSettings(s);
      if (s.cloud_provider) {
        setSelProvider(s.cloud_provider);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Patch one provider entry in place (after key save/delete). */
  const patchProvider = (name: string, patch: Partial<AiProviderInfo>) => {
    setSettings((s) =>
      s
        ? { ...s, providers: s.providers.map((p) => (p.name === name ? { ...p, ...patch } : p)) }
        : s
    );
  };

  const pickProvider = async (name: string) => {
    if (name === selProvider || switching) {
      return;
    }
    const prev = selProvider;
    setSelProvider(name);
    setKeyDraft('');
    setConfirmRemove(false);
    setSwitching(true);
    try {
      setSettings(await putAiSettings({ cloud_provider: name }));
    } catch (err) {
      setSelProvider(prev);
      notifications.show({
        color: 'hmdRed',
        title: 'Could not switch the cloud provider',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSwitching(false);
    }
  };

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key || savingKey) {
      return;
    }
    setSavingKey(true);
    try {
      const resp = await setAiKey(selProvider, key);
      patchProvider(selProvider, { configured: resp.configured, masked_key: resp.masked_key });
      setKeyDraft('');
      setTests((t) => ({ ...t, [selProvider]: { testing: false } })); // stale test result
      notifications.show({
        color: 'hmdGreen',
        message: `${label(selProvider)} key saved — it stays on this machine`,
      });
    } catch (err) {
      notifications.show({
        color: 'hmdRed',
        title: 'Could not save the key',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingKey(false);
    }
  };

  const removeKey = async () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setRemoving(true);
    try {
      const resp = await deleteAiKey(selProvider);
      // an .env key may still configure the provider — refetch for the true state
      try {
        setSettings(await getAiSettings());
      } catch {
        patchProvider(selProvider, { configured: resp.configured, masked_key: undefined });
      }
      setTests((t) => ({ ...t, [selProvider]: { testing: false } }));
      if (resp.configured) {
        notifications.show({
          color: 'hmdAmber',
          message: `Key removed from the keystore — a key in .env still configures ${label(selProvider)}`,
        });
      } else {
        notifications.show({
          color: 'hmdGreen',
          message: `${label(selProvider)} key removed — cloud calls to it are disabled`,
        });
      }
    } catch (err) {
      notifications.show({
        color: 'hmdRed',
        title: 'Could not remove the key',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  };

  const runTest = async (name: string) => {
    setTests((t) => ({ ...t, [name]: { testing: true } }));
    let result: AiTestResult;
    try {
      result = await testAiProvider(name);
    } catch (err) {
      result = { ok: false, provider: name, reason: err instanceof Error ? err.message : String(err) };
    }
    setTests((t) => ({ ...t, [name]: { testing: false, result } }));
  };

  const setRoute = async (feature: AiFeature, route: AiRoute) => {
    if (!settings || settings.routing[feature] === route || savingRoute) {
      return;
    }
    setSavingRoute(feature);
    try {
      setSettings(await putAiSettings({ routing: { [feature]: route } }));
    } catch (err) {
      notifications.show({
        color: 'hmdRed',
        title: 'Could not update the routing',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingRoute(null);
    }
  };

  // ------------------------------------------------------------------ render

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '64px 0' }}>
        <Loader size="sm" color="hmdGreen" />
      </div>
    );
  }

  if (loadError || !settings) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <PageHeader
          title="AI settings"
          subtitle="local first · cloud only with your own key · keys never leave this machine"
        />
        <DsCard padding="20px 24px" gap={10}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <StatusDot color={T.outOfRange} size={8} />
            <CardTitle size={14}>Could not load the AI settings</CardTitle>
          </div>
          <span style={mono(11.5, 400, T.tertiary)}>{loadError ?? 'no settings returned'}</span>
          <PillButton variant="secondary" onClick={() => void load()} style={{ alignSelf: 'flex-start' }}>
            Try again
          </PillButton>
        </DsCard>
      </div>
    );
  }

  const ollama = settings.providers.find((p) => p.is_local);
  const cloudProviders = settings.providers.filter((p) => !p.is_local);
  const selected = cloudProviders.find((p) => p.name === selProvider) ?? cloudProviders[0];
  const cloudConfigured = selected?.configured === true;
  const cloudRowCount = Object.values(settings.routing).filter((r) => r === 'cloud').length;
  const localOk = ollama?.configured === true;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            AI settings
            <AIPill label="YOUR MODELS, YOUR KEYS" />
          </span>
        }
        subtitle="local first · cloud only with your own key · keys never leave this machine"
      />

      {/* ------------------------------------------------------ provider cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* local — Ollama */}
        <DsCard padding="20px 24px" gap={14} style={{ border: '1.5px solid #cfe5dc' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <IconTile bg={T.greenTint} color={T.green}>
              <IconHome size={16} stroke={1.7} />
            </IconTile>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <CardTitle>Local — Ollama</CardTitle>
              <span style={mono(10, 400, T.tertiary)}>runs on this machine · no key needed</span>
            </div>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
              <StatusDot color={localOk ? T.inRange : T.watch} size={6} pulse={localOk} />
              <span style={mono(10, 500, localOk ? T.inRange : T.watch)}>
                {localOk ? 'CONFIGURED' : 'NOT CONFIGURED'}
              </span>
            </span>
          </div>

          <DetailBlock>
            <DetailRow k="model" v={ollama?.model ?? '—'} />
            <DetailRow k="endpoint" v={ollama?.base_url ?? '—'} />
            <DetailRow k="data leaves device" v="never" vColor={T.inRange} />
          </DetailBlock>

          {!localOk && (
            <span style={{ ...mono(10.5, 400, T.tertiary), lineHeight: 1.6 }}>
              Ollama isn't set up yet — install it and run <Code>ollama serve</Code>. The local path
              stays offered either way; nothing here ever needs a key.
            </span>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <PillButton
              variant="ink"
              size={11.5}
              onClick={() => void runTest('ollama')}
              disabled={tests.ollama?.testing === true}
            >
              Test
            </PillButton>
            <TestOutcome state={tests.ollama} />
          </div>

          <span style={mono(11, 400, T.inRange)}>
            ⌂ always offered — every feature can run here, nothing leaves this machine
          </span>
        </DsCard>

        {/* cloud — BYOK */}
        <DsCard padding="20px 24px" gap={14}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <IconTile bg="#fdf9f1" color={T.watch}>
              <IconCloud size={16} stroke={1.7} />
            </IconTile>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <CardTitle>Cloud — bring your own key</CardTitle>
              <span style={mono(10, 400, T.tertiary)}>
                optional · for heavier narrative + reasoning tasks
              </span>
            </div>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
              <StatusDot color={cloudConfigured ? T.inRange : T.quaternary} size={6} />
              <span style={mono(10, 500, cloudConfigured ? T.inRange : T.quaternary)}>
                {cloudConfigured ? 'KEY ADDED' : 'NO KEY'}
              </span>
            </span>
          </div>

          {/* provider picker */}
          <div
            style={{
              display: 'flex',
              gap: 2,
              background: T.chip,
              borderRadius: 20,
              padding: 2,
              alignSelf: 'flex-start',
              opacity: switching ? 0.6 : 1,
            }}
          >
            {cloudProviders.map((p) => {
              const active = p.name === selProvider;
              return (
                <button
                  key={p.name}
                  type="button"
                  disabled={switching}
                  onClick={() => void pickProvider(p.name)}
                  style={{
                    border: 'none',
                    cursor: switching ? 'default' : 'pointer',
                    ...mono(11, 500, active ? T.ink : T.tertiary),
                    padding: '6px 14px',
                    borderRadius: 16,
                    background: active ? '#ffffff' : 'transparent',
                    boxShadow: active ? T.shadowSegment : undefined,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {label(p.name)}
                </button>
              );
            })}
          </div>
          {selProvider === 'openai' && (
            <span style={{ ...mono(10, 400, T.quaternary), lineHeight: 1.6 }}>
              custom endpoint? OpenAI here talks to any compatible server — set{' '}
              <Code>OPENAI_BASE_URL</Code> in <Code>.env</Code>
            </span>
          )}

          {/* key field */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span
              style={{
                ...mono(10, 500, T.quaternary),
                letterSpacing: '.12em',
                textTransform: 'uppercase',
              }}
            >
              API key · {label(selProvider)}
            </span>

            {cloudConfigured ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  border: `1px solid ${T.hairline}`,
                  borderRadius: 13,
                  padding: '11px 15px',
                  background: T.cardFooter,
                }}
              >
                <span style={{ ...mono(13, 500, T.ink), letterSpacing: '.04em' }}>
                  {selected?.masked_key ?? '••••••••'}
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  <PillButton
                    variant="ink"
                    size={11.5}
                    onClick={() => void runTest(selProvider)}
                    disabled={tests[selProvider]?.testing === true}
                  >
                    Test
                  </PillButton>
                </span>
              </div>
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="password"
                autoComplete="off"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void saveKey();
                  }
                }}
                placeholder={cloudConfigured ? 'paste a new key to replace it' : 'paste your key'}
                aria-label={`API key for ${label(selProvider)}`}
                style={{
                  ...mono(12, 500, T.ink),
                  flex: 1,
                  minWidth: 0,
                  border: `1px solid ${T.hairline}`,
                  borderRadius: 13,
                  padding: '9px 14px',
                  outline: 'none',
                  background: '#ffffff',
                }}
              />
              <PillButton
                variant="primary"
                size={12}
                onClick={() => void saveKey()}
                disabled={keyDraft.trim() === '' || savingKey}
                disabledReason={savingKey ? 'Saving…' : undefined}
              >
                Save
              </PillButton>
            </div>

            <TestOutcome state={tests[selProvider]} />

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ paddingTop: 3 }}>
                <StatusDot color={T.inRange} size={6} />
              </span>
              <span style={{ ...mono(10.5, 400, T.tertiary), lineHeight: 1.6 }}>
                stored in your OS keychain · never in the record, never in backups, never synced (or
                an owner-only file on this machine)
              </span>
            </div>
          </div>

          <DetailBlock>
            <DetailRow k="model" v={selected?.model ?? '—'} />
            <DetailRow k="cloud rows" v={`${cloudRowCount} of ${FEATURES.length} features route here`} />
            <DetailRow k="data sent" v="record data · leaves this machine" vColor={T.watch} />
          </DetailBlock>

          {cloudConfigured && (
            <PillButton
              variant="destructive-tint"
              size={12}
              onClick={() => void removeKey()}
              disabled={removing}
              disabledReason="Removing…"
              style={{ alignSelf: 'flex-start' }}
            >
              {confirmRemove ? `Really remove the ${label(selProvider)} key?` : 'Remove key & disable cloud'}
            </PillButton>
          )}
        </DsCard>
      </div>

      {/* ------------------------------------------------------ feature routing */}
      <DsCard flush>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '18px 24px 12px' }}>
          <CardTitle>Feature routing</CardTitle>
          <span style={mono(10, 400, T.quaternary)}>
            choose the engine per feature · cloud rows need your key
          </span>
        </div>

        {FEATURES.map((f) => {
          const route = settings.routing[f.slug];
          let note: ReactNode = null;
          let noteColor: string = T.quaternary;
          if (route === 'local') {
            note = 'Ollama · on this machine';
          } else if (route === 'cloud') {
            noteColor = T.watch;
            note = cloudConfigured
              ? `☁ ${label(selected?.name ?? selProvider)} · leaves this machine`
              : 'add your key above to run this';
          } else {
            note = 'off — this feature does nothing';
          }
          return (
            <div
              key={f.slug}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.4fr 1fr auto',
                gap: 18,
                alignItems: 'center',
                padding: '13px 24px',
                borderTop: `1px solid ${T.band}`,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-.01em' }}>
                  {f.name}
                </span>
                <span style={mono(10, 400, T.tertiary)}>{f.scope}</span>
              </div>
              <RouteSegment
                value={route}
                busy={savingRoute === f.slug}
                onChange={(r) => void setRoute(f.slug, r)}
              />
              <span style={{ ...mono(10, 400, noteColor), textAlign: 'right' }}>{note}</span>
            </div>
          );
        })}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '13px 24px',
            background: T.cardFooter,
            borderTop: `1px solid ${T.band}`,
          }}
        >
          <StatusDot color={T.watch} size={6} />
          <span style={{ ...mono(11, 400, T.tertiary), lineHeight: 1.6 }}>
            Cloud rows send record data off this machine under your own key. Every cloud call names
            the recipient and is recorded in the boundary ledger.
          </span>
        </div>
      </DsCard>
    </div>
  );
}
