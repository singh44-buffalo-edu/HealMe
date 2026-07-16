/**
 * Devices fleet screen — every piece of hardware that can touch the record:
 * medication cartridges today, the Pi pill dispenser in Phase 8.
 * Design ground truth: design_handoff_healmedaily / "Web - Devices".
 * Real data only: Device resources + device-verified dose events.
 */
import { Loader } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import type { Device, Medication, MedicationAdministration } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconCpu, IconHome, IconPill, IconRouter, IconStack2, type Icon } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CardTitle, Chip, ConfidenceBar, DsCard, PageHeader, StatusDot, TableRow } from '../components/ds';
import type { CartridgeInfo } from '../fhir';
import { BASE, CS_DEVICE, loadAdmins, loadCartridges } from '../fhir';
import { T, mono } from '../tokens';

// Verification method stamped on dispenser-confirmed doses (FHIR-MAPPING §9).
const EXT_VERIFICATION = `${BASE}/StructureDefinition/administration-verification`;

const VERIFICATION: Record<string, { glyph: string; label: string }> = {
  weight: { glyph: '⚖', label: 'WEIGHT' },
  camera: { glyph: '⌗', label: 'CAMERA' },
  self: { glyph: '✎', label: 'SELF' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatWhen(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${hh}:${mm}`;
}

function medDisplay(medications: Medication[], ref?: string | null): string | undefined {
  if (!ref) return undefined;
  return medications.find((m) => `Medication/${m.id}` === ref)?.code?.text ?? 'Unnamed';
}

interface RosterStatus {
  label: string;
  color: string;
}

function cartridgeStatus(cart: CartridgeInfo): RosterStatus {
  if (!cart.enabled) return { label: 'INACTIVE', color: T.quaternary };
  if (cart.low) return { label: 'ATTENTION', color: T.watch };
  return { label: 'ACTIVE', color: T.inRange };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function DevicesPage() {
  const medplum = useMedplum();
  const [cartridges, setCartridges] = useState<CartridgeInfo[]>([]);
  const [dispensers, setDispensers] = useState<Device[]>([]);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [deviceEvents, setDeviceEvents] = useState<MedicationAdministration[]>([]);
  const [checkedAt, setCheckedAt] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      const [carts, disps, meds, admins] = await Promise.all([
        loadCartridges(medplum),
        medplum.searchResources('Device', { type: `${CS_DEVICE}|pill-dispenser`, _count: '10' }),
        medplum.searchResources('Medication', { _count: '100' }),
        loadAdmins(medplum, 14),
      ]);
      // Deterministic order (Device.id) so index-based numbering never
      // shuffles between visits — mirrors CartridgesPage.
      carts.sort((a, b) => (a.device.id ?? '').localeCompare(b.device.id ?? ''));
      setCartridges(carts);
      setDispensers(disps);
      setMedications(meds);
      setDeviceEvents(
        admins
          .filter((a) => a.extension?.some((e) => e.url === EXT_VERIFICATION))
          .sort((a, b) => (b.effectiveDateTime ?? '').localeCompare(a.effectiveDateTime ?? ''))
      );
      const now = new Date();
      setCheckedAt(
        `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      );
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

  if (loading) return <Loader />;
  if (error) {
    return (
      <DsCard gap={6}>
        <CardTitle>Could not load devices</CardTitle>
        <span style={mono(11.5, 400, T.outOfRange)}>{error}</span>
      </DsCard>
    );
  }

  const allDevices: Device[] = [...cartridges.map((c) => c.device), ...dispensers];
  const activeCount = allDevices.filter((d) => d.status === 'active').length;
  const lowCount = cartridges.filter((c) => c.enabled && c.low).length;
  const attentionCount =
    allDevices.filter((d) => d.status !== 'active').length +
    cartridges.filter((c) => c.enabled && c.low).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Devices"
        subtitle={`${allDevices.length} paired · ${activeCount} active · all data lands locally`}
      />

      {/* ---- fleet health strip ---- */}
      <DsCard padding="14px 22px" gap={0} style={{ flexDirection: 'row', alignItems: 'center', gap: 22 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusDot color={T.inRange} size={8} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {activeCount} active
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusDot color={lowCount > 0 ? T.watch : T.disabled} size={8} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {lowCount} low stock
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusDot color={attentionCount > 0 ? T.watch : T.disabled} size={8} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {attentionCount} need{attentionCount === 1 ? 's' : ''} attention
          </span>
        </span>
        <span style={{ marginLeft: 'auto', ...mono(11, 400, T.quaternary) }}>
          fleet checked {checkedAt}
        </span>
      </DsCard>

      {/* ---- roster ---- */}
      {cartridges.length === 0 ? (
        <DsCard padding={28}>
          <span style={mono(11.5, 400, T.quaternary)}>
            No devices yet — add a cartridge on the Cartridges screen to get started.
          </span>
        </DsCard>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))',
            gap: 12,
            alignItems: 'stretch',
          }}
        >
          {cartridges.map((cart, i) => (
            <CartridgeRosterCard
              key={cart.device.id}
              cart={cart}
              index={i}
              medName={medDisplay(medications, cart.medicationRef)}
            />
          ))}
        </div>
      )}

      {/* ---- dispenser ---- */}
      {dispensers.length > 0 ? (
        dispensers.map((disp) => (
          <DispenserCard
            key={disp.id}
            dispenser={disp}
            mounted={cartridges.filter((c) => c.device.parent?.reference === `Device/${disp.id}`)}
            medications={medications}
          />
        ))
      ) : (
        <DsCard padding="20px 22px" gap={7}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <IconTile icon={IconCpu} />
            <span style={mono(11.5, 400, T.quaternary)}>
              No dispenser paired yet — the Pi dispenser arrives in Phase 8 hardware setup.
            </span>
          </div>
          <span
            style={{
              ...mono(10.5, 400, T.quaternary),
              background: T.band,
              borderRadius: 20,
              padding: '4px 10px',
              alignSelf: 'flex-start',
            }}
          >
            make pi-sim · simulates a day
          </span>
        </DsCard>
      )}

      {/* ---- ingest pipeline (static explainer — how a device dose lands) ---- */}
      <DsCard padding="18px 22px" gap={12}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <CardTitle size={14.5}>How a device dose reaches your record</CardTitle>
          <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>
            local network only · nothing leaves this machine
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          <PipelineStage icon={IconCpu} stage="Device" detail="dispenser tray or cartridge" />
          <PipelineArrow />
          <PipelineStage icon={IconRouter} stage="LAN agent" detail="local network bridge" />
          <PipelineArrow />
          <PipelineStage icon={IconPill} stage="Dose event" detail="verified · time-stamped" />
          <PipelineArrow />
          <PipelineStage icon={IconHome} stage="Your record" detail="on this device" />
        </div>
        <span style={mono(10.5, 400, T.tertiary)}>
          Each dose carries how it was confirmed — ⚖ weight, ⌗ camera, or ✎ self — and lands in the
          same log as doses you enter by hand.
        </span>
      </DsCard>

      {/* ---- recent device-sourced events ---- */}
      <DsCard flush>
        <div style={{ display: 'flex', alignItems: 'baseline', padding: '16px 22px 10px', gap: 10 }}>
          <CardTitle size={14.5}>Device-logged doses</CardTitle>
          <span style={mono(10, 400, T.quaternary)}>last 14 days · strongest confirmation shown</span>
        </div>
        {deviceEvents.length === 0 ? (
          <div style={{ padding: '4px 22px 20px' }}>
            <span style={mono(11.5, 400, T.quaternary)}>
              No device-logged doses in the last 14 days — once a dispenser confirms doses, they
              appear here.
            </span>
          </div>
        ) : (
          <>
            {deviceEvents.slice(0, 10).map((event, i) => (
              <EventRow key={event.id} event={event} medications={medications} first={i === 0} />
            ))}
            {deviceEvents.length > 10 ? (
              <div style={{ padding: '10px 22px 14px', borderTop: `1px solid ${T.band}` }}>
                <span style={mono(10, 400, T.quaternary)}>
                  showing 10 of {deviceEvents.length} device-logged doses
                </span>
              </div>
            ) : null}
          </>
        )}
      </DsCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icon tile (36px rounded square on band bg — design roster card leading tile)
// ---------------------------------------------------------------------------

function IconTile({ icon: IconCmp }: { icon: Icon }) {
  return (
    <span
      style={{
        width: 36,
        height: 36,
        borderRadius: 11,
        background: T.band,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        color: T.secondary,
      }}
    >
      <IconCmp size={16} stroke={1.7} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Roster card — one per cartridge Device
// ---------------------------------------------------------------------------

function StatCell({ label, value, color = T.ink, monoValue = true }: {
  label: string;
  value: string;
  color?: string;
  monoValue?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <span style={{ ...mono(9, 500, T.quaternary), letterSpacing: '.1em' }}>{label}</span>
      <span
        style={{
          ...(monoValue ? mono(13, 500, color) : { fontSize: 12, fontWeight: 500, color }),
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function CartridgeRosterCard({
  cart,
  index,
  medName,
}: {
  cart: CartridgeInfo;
  index: number;
  medName?: string;
}) {
  const status = cartridgeStatus(cart);
  const remaining = cart.remaining;
  const capacity = cart.capacity;
  const hasStock = remaining !== undefined && capacity !== undefined && capacity > 0;

  return (
    <DsCard padding="16px 18px" gap={13} style={{ opacity: cart.enabled ? 1 : 0.65 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <IconTile icon={IconStack2} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              letterSpacing: '-.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {cart.name}
          </span>
          <span style={mono(10, 400, T.tertiary)}>medication cartridge · slot {index + 1}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <StatusDot color={status.color} size={6} />
            <span style={mono(9.5, 500, status.color)}>{status.label}</span>
          </span>
          <span style={mono(9.5, 400, T.quaternary)}>
            {hasStock ? `${remaining}/${capacity} doses` : 'no stock data'}
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1.4fr', gap: 12 }}>
        <StatCell label="CAPACITY" value={capacity !== undefined ? String(capacity) : '—'} />
        <StatCell
          label="REMAINING"
          value={remaining !== undefined ? String(remaining) : '—'}
          color={cart.enabled && cart.low ? T.watch : T.ink}
        />
        <StatCell
          label="LOW AT"
          value={cart.lowThreshold !== undefined ? String(cart.lowThreshold) : '—'}
        />
        <StatCell
          label="MEDICATION"
          value={medName ?? 'unassigned'}
          color={medName ? T.ink : T.quaternary}
          monoValue={false}
        />
      </div>

      <ConfidenceBar
        value={hasStock ? remaining / capacity : 0}
        color={T.ink}
      />

      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={mono(9.5, 400, T.quaternary)}>
          {hasStock ? `${remaining} of ${capacity} doses remaining` : 'set capacity to track stock'}
        </span>
        <Link
          to="/cartridges"
          style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 500, color: T.green, textDecoration: 'none' }}
        >
          Manage →
        </Link>
      </div>
    </DsCard>
  );
}

// ---------------------------------------------------------------------------
// Dispenser card — pill-dispenser Device with its mounted trays
// ---------------------------------------------------------------------------

function DispenserCard({
  dispenser,
  mounted,
  medications,
}: {
  dispenser: Device;
  mounted: CartridgeInfo[];
  medications: Medication[];
}) {
  const active = dispenser.status === 'active';

  return (
    <DsCard padding="18px 22px" gap={12}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <IconTile icon={IconCpu} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <CardTitle size={14.5}>
            {dispenser.deviceName?.[0]?.name ?? 'Pill dispenser'}
          </CardTitle>
          <span style={mono(10, 400, T.tertiary)}>
            pill dispenser · LAN · {mounted.length} {mounted.length === 1 ? 'tray' : 'trays'} mounted
          </span>
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <StatusDot color={active ? T.inRange : T.quaternary} size={6} />
          <span style={mono(9.5, 500, active ? T.inRange : T.quaternary)}>
            {active ? 'ACTIVE' : 'INACTIVE'}
          </span>
        </span>
      </div>

      {mounted.length === 0 ? (
        <span style={mono(11, 400, T.quaternary)}>
          No cartridges mounted yet — assign trays from the Cartridges screen.
        </span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {mounted.map((cart, i) => {
            const medName = medDisplay(medications, cart.medicationRef);
            const status = cartridgeStatus(cart);
            return (
              <div
                key={cart.device.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: T.band,
                  borderRadius: 12,
                  padding: '9px 14px',
                }}
              >
                <span style={{ ...mono(10, 500, T.secondary), width: 18, textAlign: 'center' }}>
                  {i + 1}
                </span>
                <span style={{ fontSize: 12.5, fontWeight: 500 }}>{cart.name}</span>
                <span style={mono(10, 400, T.tertiary)}>{medName ?? 'unassigned'}</span>
                <span style={{ marginLeft: 'auto', ...mono(10, 400, status.color) }}>
                  {cart.remaining !== undefined && cart.capacity !== undefined
                    ? `${cart.remaining}/${cart.capacity} doses`
                    : status.label.toLowerCase()}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </DsCard>
  );
}

// ---------------------------------------------------------------------------
// Ingest pipeline stages (static explainer — no data values)
// ---------------------------------------------------------------------------

function PipelineStage({ icon: IconCmp, stage, detail }: { icon: Icon; stage: string; detail: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        background: T.band,
        borderRadius: 12,
        padding: '9px 14px',
        flex: 1,
        minWidth: 0,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, letterSpacing: '-.01em' }}>
        <IconCmp size={13} stroke={1.7} color={T.secondary} />
        {stage}
      </span>
      <span style={{ ...mono(9.5, 400, T.tertiary), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {detail}
      </span>
    </div>
  );
}

function PipelineArrow() {
  return <span style={{ padding: '0 8px', color: T.quaternary, fontSize: 12, flexShrink: 0 }}>→</span>;
}

// ---------------------------------------------------------------------------
// Device-logged dose row
// ---------------------------------------------------------------------------

function EventRow({
  event,
  medications,
  first,
}: {
  event: MedicationAdministration;
  medications: Medication[];
  first: boolean;
}) {
  const verifyCode = event.extension?.find((e) => e.url === EXT_VERIFICATION)?.valueCode ?? '';
  const verify = VERIFICATION[verifyCode] ?? { glyph: '·', label: verifyCode.toUpperCase() || '—' };

  const medRef = event.medicationReference?.reference;
  const medName =
    event.medicationReference?.display ?? medDisplay(medications, medRef) ?? 'Medication';

  const reason = event.statusReason?.[0]?.coding?.[0]?.code;
  const outcome =
    event.status === 'completed'
      ? { label: 'TAKEN', color: T.inRange }
      : reason === 'user-skipped'
        ? { label: 'SKIPPED', color: T.watch }
        : reason === 'user-marked-missed'
          ? { label: 'MISSED', color: T.outOfRange }
          : { label: 'NOT TAKEN', color: T.quaternary };

  return (
    <TableRow columns="130px 1fr auto auto" first={first} padding="11px 22px">
      <span style={mono(10.5, 400, T.tertiary)}>{formatWhen(event.effectiveDateTime)}</span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: '-.01em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {medName}
      </span>
      <Chip>
        {verify.glyph} {verify.label}
      </Chip>
      <span style={{ ...mono(10, 500, outcome.color), width: 72, textAlign: 'right' }}>
        {outcome.label}
      </span>
    </TableRow>
  );
}
