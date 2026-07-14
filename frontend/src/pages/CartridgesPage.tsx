import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Bundle, Device, Medication } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import type { CartridgeInfo } from '../fhir';
import { CS_DEVICE, EXT_DEVICE_MED, EXT_SUPPLY_TARGET, IDENT, getPatient, loadCartridges } from '../fhir';

export function CartridgesPage() {
  const medplum = useMedplum();
  const [cartridges, setCartridges] = useState<CartridgeInfo[]>([]);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      const [carts, meds] = await Promise.all([
        loadCartridges(medplum),
        medplum.searchResources('Medication', { _count: '100' }),
      ]);
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
      <Alert color="red" title="Could not load cartridges">
        {error}
      </Alert>
    );
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Cartridges</Title>
        <Button onClick={addCartridge}>Add cartridge</Button>
      </Group>
      <Text c="dimmed" size="sm">
        One medication per cartridge. The future pill dispenser reads exactly this mapping — stock counts are
        informational and never decide whether a dose can be taken.
      </Text>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {cartridges.map((cart) => (
          <CartridgeCard key={cart.device.id} cart={cart} medications={medications} onChanged={reload} />
        ))}
      </SimpleGrid>
      {cartridges.length === 0 && <Text c="dimmed">No cartridges yet — add one to get started.</Text>}
    </Stack>
  );
}

function CartridgeCard({
  cart,
  medications,
  onChanged,
}: {
  cart: CartridgeInfo;
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
      await medplum.executeBatch(bundle);
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
  const pct = Math.min(100, Math.round((100 * remaining) / cap));

  return (
    <Card withBorder opacity={enabled ? 1 : 0.6}>
      <Stack gap="xs">
        <Group justify="space-between">
          <TextInput value={name} onChange={(e) => setName(e.currentTarget.value)} size="sm" w={180} />
          <Group gap="xs">
            {cart.low && enabled && <Badge color="orange">low stock</Badge>}
            <Switch checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} label="enabled" />
          </Group>
        </Group>
        <Select
          label="Medication"
          placeholder="Assign a medication"
          data={medications.map((m) => ({ value: `Medication/${m.id}`, label: m.code?.text ?? 'Unnamed' }))}
          value={medRef}
          onChange={setMedRef}
          clearable
        />
        <Group grow>
          <NumberInput label="Capacity" value={capacity} onChange={setCapacity} min={1} max={500} />
          <NumberInput label="Low-stock threshold" value={threshold} onChange={setThreshold} min={0} max={100} />
        </Group>
        <div>
          <Group justify="space-between" mb={4}>
            <Text size="sm">Stock</Text>
            <Text size="sm" c="dimmed">
              {remaining} / {cap} doses
            </Text>
          </Group>
          <Progress value={pct} color={cart.low ? 'orange' : 'teal'} />
        </div>
        <Group>
          <Button size="compact-sm" onClick={save} loading={busy}>
            Save
          </Button>
          <Button size="compact-sm" variant="light" onClick={refill} loading={busy}>
            Log refill (fill to capacity)
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
