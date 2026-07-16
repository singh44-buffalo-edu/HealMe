/**
 * CartridgesPage — configure medication cartridges (the pill-dispenser trays
 * of Phase 8): rack list, per-cartridge settings, stock & refill logging.
 *
 * Architecture: routed from App.tsx; talks straight to the Medplum CDR via
 * MedplumClient. Cartridge parsing lives in ../fhir (loadCartridges /
 * CartridgeInfo); DevicesPage renders the same Devices read-only.
 *
 * FHIR model (FHIR-MAPPING.md §5 — read it before touching shapes):
 * - One cartridge = one Device (type local code medication-cartridge).
 *   Capacity / remaining-count / low-stock-threshold are Device.property
 *   entries; the assigned med is the device-assigned-medication extension.
 * - NO Device.patient — in R4 that means a device affixed to the body; the
 *   AccessPolicy grants Device access explicitly instead.
 * - Refill = SupplyDelivery (with supplydelivery-target-cartridge extension)
 *   + Device stock reset, committed as ONE transaction Bundle (§6 multi-
 *   resource writes) with per-entry status checks (Medplum partial-commit
 *   quirk, CLAUDE.md §9).
 *
 * SAFETY INVARIANT (owner-signed, CLAUDE.md §3): inventory is informational
 * only — stock counts NEVER gate whether a medication may be taken. The only
 * gating on this page is on *logging a refill* (needs a capacity / not
 * already full), never on dosing, and even that keeps an explicit override.
 */
import { Loader, NumberInput, Select, Switch, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Bundle, Device, Medication } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import { CardTitle, DsCard, PageHeader, PillButton, StatusDot } from '../components/ds';
import type { CartridgeInfo } from '../fhir';
import { CS_DEVICE, EXT_DEVICE_MED, EXT_SUPPLY_TARGET, IDENT, getPatient, loadCartridges } from '../fhir';
import { T, mono } from '../tokens';

// ---------------------------------------------------------------------------
// Hardware identity palette (design handoff "Web - Cartridge Filling").
// Dedicated cartridge-identity colours — never reuse data-class colors
// (green/indigo/amber) for cartridge identity, and never use these for data.
// ---------------------------------------------------------------------------

const HW_PALETTE = [
  { color: '#0a84ff', tint: '#eff5fc', name: 'blue' },
  { color: '#e8891b', tint: '#fcf4ea', name: 'orange' },
  { color: '#bf5af2', tint: '#f8f2fc', name: 'purple' },
  { color: '#00a3ad', tint: '#eef8f8', name: 'teal' },
] as const;

function hwIdentity(index: number): (typeof HW_PALETTE)[number] {
  return HW_PALETTE[index % HW_PALETTE.length];
}

// Ring surface hexes (spec-exact; intentionally not in tokens.ts)
const RING_DISC = '#fdfdfc';
const RING_HUB = '#ececea';
const RING_STROKE_GREY = '#d9d9d5';
const RING_EMPTY_FILL = '#f7f7f5';

const INPUT_STYLES = {
  label: { fontSize: 11.5, fontWeight: 500, color: T.secondary, marginBottom: 4 },
} as const;

const MONO_INPUT_STYLES = {
  ...INPUT_STYLES,
  input: { fontFamily: T.mono, fontSize: 12.5 },
} as const;

/** Human label for a Medication reference from the pre-fetched catalog —
 * undefined when unassigned (callers render "unassigned"). */
function medDisplay(medications: Medication[], ref?: string | null): string | undefined {
  if (!ref) return undefined;
  return medications.find((m) => `Medication/${m.id}` === ref)?.code?.text ?? 'Unnamed';
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Cartridge manager: left rail = the rack (one RailCard per Device), right =
 * the selected cartridge's detail/refill pane.
 *
 * FHIR touched: reads Device (cartridges) + Medication catalog; creates a
 * Device on "Add cartridge"; updates/refills happen in CartridgeDetail.
 * Failure modes: load errors render the error card; add errors surface as a
 * notification and change nothing.
 */
export function CartridgesPage() {
  const medplum = useMedplum();
  const [cartridges, setCartridges] = useState<CartridgeInfo[]>([]);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selId, setSelId] = useState<string>();

  const reload = useCallback(async () => {
    try {
      const [carts, meds] = await Promise.all([
        loadCartridges(medplum),
        medplum.searchResources('Medication', { _count: '100' }),
      ]);
      // Deterministic order (Device.id) so index-based numbers/colours don't
      // shuffle between visits — server search order is not contractually stable.
      carts.sort((a, b) => (a.device.id ?? '').localeCompare(b.device.id ?? ''));
      setCartridges(carts);
      setMedications(meds);
      setError(undefined);
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setLoading(false);
    }
  }, [medplum]);

  useEffect(() => {
    reload();
  }, [reload]);

  /** Create a fresh cartridge Device with the default properties (capacity 30,
   * empty, low-stock at 5 — defaults, not clinical values). Identifier is a
   * new UUID (durable cartridge identity, FHIR-MAPPING.md §7), so a double
   * click creates two cartridges — acceptable, they're deletable config. */
  const addCartridge = async () => {
    try {
      await medplum.createResource<Device>({
        resourceType: 'Device',
        status: 'active',
        identifier: [{ system: `${IDENT}/device`, value: crypto.randomUUID() }],
        deviceName: [{ name: `Cartridge ${cartridges.length + 1}`, type: 'user-friendly-name' }],
        type: { coding: [{ system: CS_DEVICE, code: 'medication-cartridge' }] },
        property: [
          { type: { coding: [{ system: CS_DEVICE, code: 'capacity' }] }, valueQuantity: [{ value: 30, unit: 'doses' }] },
          { type: { coding: [{ system: CS_DEVICE, code: 'remaining-count' }] }, valueQuantity: [{ value: 0, unit: 'doses' }] },
          { type: { coding: [{ system: CS_DEVICE, code: 'low-stock-threshold' }] }, valueQuantity: [{ value: 5, unit: 'doses' }] },
        ],
      });
      notifications.show({ color: 'teal', message: 'Cartridge added' });
      await reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not add cartridge', message: normalizeErrorString(err) });
    }
  };

  if (loading) return <Loader />;
  if (error) {
    return (
      <DsCard gap={6}>
        <CardTitle>Could not load cartridges</CardTitle>
        <span style={mono(11.5, 400, T.outOfRange)}>{error}</span>
      </DsCard>
    );
  }

  const enabledCount = cartridges.filter((c) => c.enabled).length;
  const lowCount = cartridges.filter((c) => c.low && c.enabled).length;
  const selIndex = Math.max(
    0,
    cartridges.findIndex((c) => c.device.id === selId)
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Cartridges"
        subtitle={`${cartridges.length} ${cartridges.length === 1 ? 'cartridge' : 'cartridges'} · ${enabledCount} enabled · ${lowCount} low stock`}
        right={
          <PillButton variant="primary" onClick={addCartridge}>
            Add cartridge
          </PillButton>
        }
      />

      {cartridges.length === 0 ? (
        <DsCard padding={28}>
          <span style={mono(11.5, 400, T.quaternary)}>No cartridges yet — add one to get started.</span>
        </DsCard>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, alignItems: 'stretch' }}>
          {/* -------- left rail: the rack -------- */}
          <DsCard padding="24px 22px" gap={8}>
            <span
              style={{
                ...mono(10, 500, T.quaternary),
                letterSpacing: '.12em',
                textTransform: 'uppercase',
                paddingBottom: 4,
              }}
            >
              The rack — {cartridges.length} {cartridges.length === 1 ? 'cartridge' : 'cartridges'}
            </span>
            {cartridges.map((cart, i) => (
              <RailCard
                key={cart.device.id}
                cart={cart}
                index={i}
                selected={i === selIndex}
                medName={medDisplay(medications, cart.medicationRef)}
                onPick={() => setSelId(cart.device.id)}
              />
            ))}
            <div
              style={{
                marginTop: 'auto',
                background: T.cardFooter,
                borderRadius: 14,
                padding: '12px 15px',
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
              }}
            >
              <span style={{ ...mono(9, 500, T.quaternary), letterSpacing: '.1em' }}>WHY COLOURS + NUMBERS</span>
              <span style={{ ...mono(10.5, 400, T.tertiary), lineHeight: 1.6 }}>
                Numbers and colours make cartridges easier to talk about — "the orange one, number 2." They follow
                this app's ordering only (colours repeat past four, and nothing is printed on the hardware yet), so
                go by the assigned medication, not the colour.
              </span>
            </div>
          </DsCard>

          {/* -------- right: fill / refill flow for the selected cartridge -------- */}
          {/* Every detail pane stays mounted (hidden when not selected) so
              in-progress edits survive switching selection — the same
              per-cartridge draft state the pre-restyle grid had. */}
          <div style={{ minWidth: 0 }}>
            {cartridges.map((cart, i) => (
              <div key={cart.device.id} style={{ display: i === selIndex ? undefined : 'none' }}>
                <CartridgeDetail cart={cart} index={i} medications={medications} onChanged={reload} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: T.card,
          borderRadius: 16,
          padding: '13px 20px',
          boxShadow: '0 1px 2px rgba(0,0,0,.04)',
        }}
      >
        <StatusDot color={T.inRange} size={6} />
        <span style={mono(11, 400, T.tertiary)}>
          Logging a refill records what went in, how many doses, and when. One medication per cartridge. The future
          pill dispenser reads exactly this mapping — stock counts are informational and never decide whether a dose
          can be taken.
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left-rail cartridge card (disc side view + name + state + meta)
// ---------------------------------------------------------------------------

/** One rack entry: disc side-view in the cartridge's identity colour, name,
 * and a state word derived purely from Device data (DISABLED / SPARE / EMPTY
 * / "N LEFT"). Low stock shows amber on the value only — status colour never
 * floods the card (DS rule, CLAUDE.md §2). */
function RailCard({
  cart,
  index,
  selected,
  medName,
  onPick,
}: {
  cart: CartridgeInfo;
  index: number;
  selected: boolean;
  medName?: string;
  onPick: () => void;
}) {
  const id = hwIdentity(index);
  const remaining = cart.remaining ?? 0;

  let state = '';
  let stateColor: string = T.quaternary;
  if (!cart.enabled) {
    state = 'DISABLED';
  } else if (!cart.medicationRef) {
    state = 'SPARE';
  } else if (remaining <= 0) {
    state = 'EMPTY';
  } else if (cart.low) {
    state = `${remaining} LEFT`;
    stateColor = T.watch;
  } else {
    state = `${remaining} LEFT`;
    stateColor = T.inRange;
  }

  const active = cart.enabled && Boolean(cart.medicationRef);
  const meta = `${medName ?? 'unassigned'} · ${remaining}/${cart.capacity ?? '—'} doses`;

  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        border: selected ? `2px solid ${id.color}` : `1px solid ${T.chip}`,
        cursor: 'pointer',
        textAlign: 'left',
        background: selected ? id.tint : T.card,
        borderRadius: 14,
        padding: '11px 13px',
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        fontFamily: 'inherit',
        boxSizing: 'border-box',
        width: '100%',
        opacity: cart.enabled ? 1 : 0.6,
      }}
    >
      {/* disc side view with colour rim */}
      <div
        style={{
          width: 54,
          height: 13,
          borderRadius: 7,
          background: `linear-gradient(180deg,${RING_DISC},${RING_HUB})`,
          border: '1px solid #e0e0dc',
          borderTop: `3px solid ${id.color}`,
          boxSizing: 'border-box',
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
        }}
      >
        <span style={{ ...mono(8, 500, id.color), fontWeight: 600, lineHeight: 1 }}>{index + 1}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              letterSpacing: '-.01em',
              color: active ? T.ink : T.tertiary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {cart.name}
          </span>
          <span style={{ marginLeft: 'auto', ...mono(9, 500, stateColor), whiteSpace: 'nowrap' }}>{state}</span>
        </div>
        <span style={{ ...mono(9.5, 400, T.tertiary), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {meta}
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Capacity ring — the design's 7-wedge tray wheel repurposed: one segment per
// dose (≤30), plain arcs above that. remaining = green, next dose = cartridge
// colour, consumed = grey.
// ---------------------------------------------------------------------------

interface RingSeg {
  d: string;
  fill: string;
  stroke: string;
  sw: number;
}

/** SVG path for one donut segment between angles a0→a1 (radians) on the
 * 220×220 viewBox: outer radius 99, inner 20, centred at (110,110). The
 * `a0 + 0.01` floor keeps degenerate (zero-width) segments renderable. */
function donutPath(a0: number, a1: number): string {
  const cx = 110;
  const cy = 110;
  const r0 = 20;
  const r1 = 99;
  const end = Math.max(a1, a0 + 0.01);
  const pt = (r: number, a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0o, y0o] = pt(r1, a0);
  const [x1o, y1o] = pt(r1, end);
  const [x0i, y0i] = pt(r0, a0);
  const [x1i, y1i] = pt(r0, end);
  const large = end - a0 > Math.PI ? 1 : 0;
  return (
    `M${x0i.toFixed(1)},${y0i.toFixed(1)} L${x0o.toFixed(1)},${y0o.toFixed(1)} ` +
    `A${r1},${r1} 0 ${large} 1 ${x1o.toFixed(1)},${y1o.toFixed(1)} ` +
    `L${x1i.toFixed(1)},${y1i.toFixed(1)} ` +
    `A${r0},${r0} 0 ${large} 0 ${x0i.toFixed(1)},${y0i.toFixed(1)} Z`
  );
}

/** Top-down capacity ring. ≤30 doses ⇒ one wedge per dose (grey consumed →
 * cartridge-colour "next dose" → green remaining, clockwise from 12); >30 ⇒
 * two plain arcs, because per-dose wedges become unreadable. Purely visual —
 * remaining/capacity are clamped defensively, never written back. */
function CapacityRing({
  capacity,
  remaining,
  color,
  tint,
  num,
}: {
  capacity: number;
  remaining: number;
  color: string;
  tint: string;
  num: number;
}) {
  const cap = Math.max(1, Math.round(capacity));
  const rem = Math.min(Math.max(remaining, 0), cap);
  const consumed = cap - rem;

  const styleFor = (s: 'v' | 'f' | 'e'): Omit<RingSeg, 'd'> =>
    s === 'v'
      ? { fill: T.heatTaken, stroke: T.inRange, sw: 1.2 }
      : s === 'f'
        ? { fill: tint, stroke: color, sw: 2.5 }
        : { fill: RING_EMPTY_FILL, stroke: RING_STROKE_GREY, sw: 1.2 };

  const start = -Math.PI / 2;
  const TAU = Math.PI * 2;
  const G = 0.02; // angular gap trimmed off each side (thin separation)
  const segs: RingSeg[] = [];

  if (cap <= 30) {
    // one donut segment per dose, clockwise from 12 o'clock
    for (let k = 0; k < cap; k++) {
      const a0 = (k / cap) * TAU + start + G;
      const a1 = ((k + 1) / cap) * TAU + start - G;
      const status: 'v' | 'f' | 'e' = k < consumed ? 'e' : k === consumed && rem > 0 ? 'f' : 'v';
      segs.push({ d: donutPath(a0, a1), ...styleFor(status) });
    }
  } else if (consumed === 0 || rem === 0) {
    // full circle in a single state → two half arcs
    const st = styleFor(rem === 0 ? 'e' : 'v');
    segs.push({ d: donutPath(start + G, start + TAU / 2 - G), ...st });
    segs.push({ d: donutPath(start + TAU / 2 + G, start + TAU - G), ...st });
  } else {
    // two plain arcs: consumed (grey) then remaining (green), clockwise from top
    const boundary = start + (consumed / cap) * TAU;
    segs.push({ d: donutPath(start + G, boundary - G), ...styleFor('e') });
    segs.push({ d: donutPath(boundary + G, start + TAU - G), ...styleFor('v') });
  }

  const showNext = cap <= 30 && rem > 0;

  return (
    <>
      <div style={{ position: 'relative', width: '100%', maxWidth: 340, alignSelf: 'center', aspectRatio: '1' }}>
        <svg viewBox="0 0 220 220" style={{ width: '100%', height: '100%', display: 'block' }}>
          <circle cx={110} cy={110} r={102} fill={RING_DISC} stroke={color} strokeWidth={5} />
          {segs.map((s, i) => (
            <path key={i} d={s.d} fill={s.fill} stroke={s.stroke} strokeWidth={s.sw} />
          ))}
          <circle cx={110} cy={110} r={17} fill={RING_HUB} stroke={RING_STROKE_GREY} strokeWidth={1.5} />
        </svg>
        <span
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%,-50%)',
            ...mono(11, 500, T.tertiary),
            fontWeight: 600,
            pointerEvents: 'none',
          }}
        >
          {num}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', ...mono(9.5, 400, T.tertiary) }}>
        <span>
          <span style={{ color: T.inRange }}>▮</span> remaining
        </span>
        {showNext ? (
          <span>
            <span style={{ color }}>▮</span> next dose
          </span>
        ) : null}
        <span>
          <span style={{ color: T.disabled }}>▮</span> empty
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Spec row (mono key-value)
// ---------------------------------------------------------------------------

function SpecRow({ label, value, valueColor = T.ink }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={mono(10.5, 400, T.tertiary)}>{label}</span>
      <span style={{ ...mono(10.5, 400, valueColor), textAlign: 'right' }}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail pane for the selected cartridge — colour-lock header, capacity ring,
// settings, stock & refill. All FHIR logic is unchanged from the pre-restyle
// CartridgeCard.
// ---------------------------------------------------------------------------

function CartridgeDetail({
  cart,
  index,
  medications,
  onChanged,
}: {
  cart: CartridgeInfo;
  index: number;
  medications: Medication[];
  onChanged: () => void;
}) {
  const medplum = useMedplum();
  const [name, setName] = useState(cart.name);
  const [medRef, setMedRef] = useState<string | null>(cart.medicationRef ?? null);
  const [capacity, setCapacity] = useState<number | string>(cart.capacity ?? 30);
  const [threshold, setThreshold] = useState<number | string>(cart.lowThreshold ?? 5);
  const [enabled, setEnabled] = useState(cart.enabled);
  const [busy, setBusy] = useState(false);

  /**
   * Assemble the updated Device from the form drafts, cloned off the loaded
   * resource so meta.versionId is preserved (Medplum optimistic locking).
   * `remaining` is only touched when explicitly passed (refill path) —
   * a plain settings save never resets stock.
   */
  const buildDevice = (remaining?: number): Device => {
    const device: Device = structuredClone(cart.device);
    device.status = enabled ? 'active' : 'inactive';
    device.deviceName = [{ name: name || 'Cartridge', type: 'user-friendly-name' }];
    device.extension = (device.extension ?? []).filter((e) => e.url !== EXT_DEVICE_MED);
    if (medRef) {
      device.extension.push({ url: EXT_DEVICE_MED, valueReference: { reference: medRef } });
    }
    const setProp = (code: string, value: number) => {
      const props = device.property ?? [];
      const existing = props.find((p) => p.type?.coding?.some((c) => c.code === code));
      if (existing) {
        existing.valueQuantity = [{ value, unit: 'doses' }];
      } else {
        props.push({ type: { coding: [{ system: CS_DEVICE, code }] }, valueQuantity: [{ value, unit: 'doses' }] });
      }
      device.property = props;
    };
    setProp('capacity', Number(capacity) || 0);
    setProp('low-stock-threshold', Number(threshold) || 0);
    if (remaining !== undefined) setProp('remaining-count', remaining);
    return device;
  };

  const save = async () => {
    setBusy(true);
    try {
      await medplum.updateResource(buildDevice());
      notifications.show({ color: 'teal', message: `${name} saved` });
      onChanged();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save cartridge', message: normalizeErrorString(err) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Log a refill: one transaction Bundle = SupplyDelivery (what went in, how
   * many doses, when, which cartridge via the target-cartridge extension) +
   * PUT of the Device with remaining reset to capacity (FHIR-MAPPING.md §5).
   * The SupplyDelivery identifier is a fresh client UUID (refill = client
   * event, §7), so retrying after a *reported* failure logs a new event —
   * fine, since the Device write is what carries the stock truth.
   */
  const refill = async () => {
    setBusy(true);
    try {
      const patient = await getPatient(medplum);
      const cap = Number(capacity) || 0;
      const refillAmount = cap - (cart.remaining ?? 0);
      const bundle: Bundle = {
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [
          {
            resource: {
              resourceType: 'SupplyDelivery',
              status: 'completed',
              identifier: [{ system: `${IDENT}/supply-delivery`, value: crypto.randomUUID() }],
              patient: patient ? { reference: `Patient/${patient.id}` } : undefined,
              occurrenceDateTime: new Date().toISOString(),
              suppliedItem: {
                itemReference: medRef ? { reference: medRef } : undefined,
                quantity: { value: Math.max(refillAmount, 0), unit: 'doses' },
              },
              extension: [
                { url: EXT_SUPPLY_TARGET, valueReference: { reference: `Device/${cart.device.id}` } },
              ],
            },
            request: { method: 'POST', url: 'SupplyDelivery' },
          },
          {
            resource: buildDevice(cap),
            request: { method: 'PUT', url: `Device/${cart.device.id}` },
          },
        ],
      };
      const result = await medplum.executeBatch(bundle);
      // Medplum can commit valid entries while individual entries fail —
      // inspect every entry status instead of trusting the 200 (CLAUDE.md).
      const bad = (result.entry ?? []).filter((e) => !e.response?.status?.startsWith('2'));
      if (bad.length > 0) {
        throw new Error(`refill partially failed: ${bad.map((e) => e.response?.status).join(', ')}`);
      }
      notifications.show({ color: 'teal', message: `${name} refilled to ${cap} doses` });
      onChanged();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not refill', message: normalizeErrorString(err) });
    } finally {
      setBusy(false);
    }
  };

  const remaining = cart.remaining ?? 0;
  const cap = Number(capacity) || 1;

  const id = hwIdentity(index);
  const num = index + 1;
  const medName = medDisplay(medications, medRef);

  const pill = !enabled
    ? { color: T.quaternary, label: 'DISABLED' }
    : cart.low
      ? { color: T.watch, label: `LOW STOCK · ${remaining} LEFT` }
      : { color: T.inRange, label: 'ENABLED ✓' };

  // Gate the primary refill action with the blocking reason as its label.
  // The at-capacity gate keeps an explicit override below (existing behavior:
  // a refill could always be logged), so no capability is removed.
  // NB: this gates *logging a refill event* only — never dose-taking
  // (inventory-never-gates-dosing invariant, FHIR-MAPPING.md §5).
  const capValue = Number(capacity) || 0;
  const gateReason =
    capValue < 1
      ? 'Log refill — set a capacity first'
      : remaining >= capValue
        ? `Log refill — already at ${capValue} doses`
        : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {/* colour-lock header */}
      <div
        style={{
          background: id.tint,
          borderRadius: 20,
          padding: '20px 26px',
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          border: `2px solid ${id.color}`,
          boxSizing: 'border-box',
          opacity: enabled ? 1 : 0.6,
        }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: '50%',
            background: id.color,
            display: 'grid',
            placeItems: 'center',
            ...mono(22, 500, '#fff'),
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {num}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-.015em' }}>
            Cartridge {num} · {name || 'Cartridge'} · {id.name}
          </span>
          <span style={mono(11, 400, T.secondary)}>
            {medName ?? 'unassigned'} · {remaining} of {cap} doses remaining
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: T.card,
            borderRadius: 16,
            padding: '8px 14px',
            flexShrink: 0,
          }}
        >
          <StatusDot color={pill.color} size={7} />
          <span style={mono(10.5, 500, pill.color)}>{pill.label}</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 14, alignItems: 'stretch' }}>
        {/* capacity ring */}
        <DsCard padding="20px 24px" gap={10}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <CardTitle size={14}>Cartridge from above</CardTitle>
            <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>
              {remaining} of {cap} doses remaining
            </span>
          </div>
          <CapacityRing capacity={cap} remaining={remaining} color={id.color} tint={id.tint} num={num} />
        </DsCard>

        {/* settings + stock & refill */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <DsCard padding="16px 20px" gap={9}>
            <CardTitle size={13}>Cartridge settings</CardTitle>
            <TextInput
              label="Name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              size="sm"
              styles={INPUT_STYLES}
            />
            <Select
              label="Medication"
              placeholder="Assign a medication"
              data={medications.map((m) => ({ value: `Medication/${m.id}`, label: m.code?.text ?? 'Unnamed' }))}
              value={medRef}
              onChange={setMedRef}
              clearable
              size="sm"
              styles={INPUT_STYLES}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <NumberInput
                label="Capacity"
                value={capacity}
                onChange={setCapacity}
                min={1}
                max={500}
                size="sm"
                styles={MONO_INPUT_STYLES}
              />
              <NumberInput
                label="Low-stock threshold"
                value={threshold}
                onChange={setThreshold}
                min={0}
                max={100}
                size="sm"
                styles={MONO_INPUT_STYLES}
              />
            </div>
            <Switch
              checked={enabled}
              onChange={(e) => setEnabled(e.currentTarget.checked)}
              label="enabled"
              size="sm"
              color="hmdGreen"
              styles={{ label: { fontSize: 12.5, color: T.secondary } }}
            />
            <PillButton
              variant="primary"
              onClick={save}
              disabled={busy}
              style={{ width: '100%', padding: '11px 0', borderRadius: 16, fontSize: 13 }}
            >
              Save
            </PillButton>
          </DsCard>

          <DsCard padding="16px 20px" gap={9}>
            <CardTitle size={13}>Stock & refill</CardTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <SpecRow
                label="remaining"
                value={`${remaining} / ${cap} doses`}
                valueColor={cart.low && enabled ? T.watch : T.ink}
              />
              <SpecRow label="low-stock threshold" value={`${Number(threshold) || 0} doses`} />
              <SpecRow
                label="assigned medication"
                value={medName ?? 'unassigned'}
                valueColor={medName ? T.ink : T.quaternary}
              />
            </div>
            <PillButton
              variant="primary"
              onClick={refill}
              disabled={busy || Boolean(gateReason)}
              disabledReason={gateReason}
              style={{ width: '100%', padding: '11px 0', borderRadius: 16, fontSize: 13 }}
            >
              Log refill — fill to {capValue} doses
            </PillButton>
            {gateReason && capValue >= 1 ? (
              <PillButton
                variant="secondary"
                onClick={refill}
                disabled={busy}
                style={{ width: '100%', padding: '9px 0', borderRadius: 16, fontSize: 12 }}
              >
                Refilled it anyway — log the event
              </PillButton>
            ) : null}
          </DsCard>
        </div>
      </div>
    </div>
  );
}
