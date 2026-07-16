"""Build today's dose slots from active MedicationRequests + cartridge Devices.

==============================================================================
⚠ DOSE-SLOT IDENTITY IS A THREE-WAY CONTRACT — DO NOT CHANGE IT UNILATERALLY
==============================================================================
`DoseSlot.ident_value` MUST byte-for-byte match what the frontend
(frontend/src/fhir.ts `slotIdentValue`: `{slug}-{date}T{time.slice(0,5)}`)
and scripts/seed.py compute for the same scheduled dose:

    identifier system  https://healmedaily.local/fhir/identifier/medication-administration
    identifier value   {request-slug}-{YYYY-MM-DD}T{HH:MM}     (minutes, no seconds)

This is the whole point of FHIR-MAPPING.md §3/§9: one scheduled dose = ONE
logical MedicationAdministration, no matter who logs it. A dispenser pickup,
a manual tap in the app, and a skipped→taken correction all address the same
identifier, so conditional create/ifMatch-update converge instead of
duplicating. Change the format in one place and adherence dashboards start
double-counting doses. tests/test_schedule.py and the frontend tests both
pin the literal string — if you touch this, update all three code sites, the
tests, and FHIR-MAPPING.md §7 together (owner sign-off: data-model change).

Slot sources: called by cli.py (sim mode: scenario fixtures; run/status
mode: `fetch_regimen` over the live Medplum client). Output feeds
agent.DispenserAgent.run_day and events.py payload builders.

Med -> tray mapping: each cartridge Device carries the
device-assigned-medication extension (-> Medication) and, once mounted,
Device.parent -> the dispenser Device. The tray number is the trailing
integer of the cartridge's project identifier (device|cartridge-3 -> tray 3)
or its user-friendly deviceName ("Cartridge 3").
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time as dtime

from .consts import DEVICE_CARTRIDGE, DEVICE_DISPENSER, EXT_DEVICE_MED, IDENT_DEVICE, IDENT_REQUEST

_TIME_OF_DAY = re.compile(r"^\d{2}:\d{2}:\d{2}$")


def parse_time_of_day(value: str) -> dtime:
    """FHIR `time` requires seconds — '09:00:00', never '09:00' (CLAUDE.md §9)."""
    if not _TIME_OF_DAY.match(value or ""):
        raise ValueError(f'FHIR timing.repeat.timeOfDay requires seconds ("09:00:00"); got "{value}"')
    return dtime.fromisoformat(value)


@dataclass(frozen=True)
class DoseSlot:
    """One scheduled dose occurrence for one day — the unit the agent works
    in. Frozen: a slot is an identity, never mutated after building."""

    scheduled: datetime  # tz-aware local occurrence
    date: str  # YYYY-MM-DD
    time: str  # HH:MM:SS
    request_id: str  # MedicationRequest.id, for literal references in events
    request_slug: str  # project identifier value (or id fallback) — identity input
    medication_ref: str  # "Medication/{id}"
    medication_display: str  # human label for logs/payload display fields
    life_critical: bool = False  # owner-set extension, never inferred (CLAUDE.md §8)
    tray: int | None = None  # None = med has no mounted cartridge (dispense defaults to tray 1)
    cartridge_id: str | None = None  # cartridge Device.id, referenced in dose events

    @property
    def ident_value(self) -> str:
        """Stable dose-event identity: request + scheduled occurrence (§3).

        `time[:5]` truncates to HH:MM — the frontend's slotIdentValue does
        `time.slice(0, 5)`, so seconds NEVER appear in identifiers even
        though FHIR timeOfDay carries them. See module docstring before
        changing anything here."""
        return f"{self.request_slug}-{self.date}T{self.time[:5]}"


@dataclass
class Regimen:
    """Everything fetched from Medplum that slot-building needs — one bundle
    per day so the agent works off a consistent snapshot."""

    requests: list[dict] = field(default_factory=list)  # active MedicationRequests
    cartridges: list[dict] = field(default_factory=list)  # active cartridge Devices
    medication_displays: dict[str, str] = field(default_factory=dict)  # "Medication/x" -> text
    dispenser: dict | None = None  # this machine's pill-dispenser Device (None = not registered)


def request_slug(request: dict) -> str:
    """The identity half of ident_value: the request's project identifier
    (identifier/medication-request), falling back to the resource id — the
    same fallback order the frontend's requestSlugBase uses."""
    for ident in request.get("identifier", []):
        if ident.get("system") == IDENT_REQUEST and ident.get("value"):
            return ident["value"]
    return request.get("id", "unknown-request")


def _trailing_int(text: str | None) -> int | None:
    match = re.search(r"(\d+)\s*$", text or "")
    return int(match.group(1)) if match else None


def tray_for_cartridge(device: dict) -> int | None:
    """Physical tray number for a cartridge Device, or None when it can't be
    derived. Project identifier wins ("cartridge-3" -> 3); user-friendly
    deviceName ("Cartridge 3") is the fallback for hand-made Devices."""
    for ident in device.get("identifier", []):
        if ident.get("system") == IDENT_DEVICE:
            tray = _trailing_int(ident.get("value"))
            if tray is not None:
                return tray
    for name in device.get("deviceName", []):
        tray = _trailing_int(name.get("name"))
        if tray is not None:
            return tray
    return None


def cartridge_medication_ref(device: dict) -> str | None:
    """The Medication this cartridge holds, via the device-assigned-medication
    extension (FHIR-MAPPING.md §5). None = unassigned cartridge."""
    for ext in device.get("extension", []):
        if ext.get("url") == EXT_DEVICE_MED:
            return (ext.get("valueReference") or {}).get("reference")
    return None


def map_trays(cartridges: list[dict], dispenser_id: str | None) -> dict[str, tuple[int | None, str | None]]:
    """medication reference -> (tray number, cartridge Device id).

    When a dispenser id is known, only cartridges mounted on it
    (Device.parent) or not yet mounted anywhere (legacy pre-Phase-8 seeds)
    are considered; cartridges on a *different* dispenser are excluded.

    Two cartridges holding the same med: the lowest tray number wins
    (deterministic via the sort below), the duplicate is ignored.
    """
    mapping: dict[str, tuple[int | None, str | None]] = {}
    for device in sorted(cartridges, key=lambda d: tray_for_cartridge(d) or 99):
        if device.get("status") not in (None, "active"):
            continue
        parent = (device.get("parent") or {}).get("reference")
        if dispenser_id and parent and parent != f"Device/{dispenser_id}":
            continue
        med_ref = cartridge_medication_ref(device)
        if med_ref and med_ref not in mapping:
            mapping[med_ref] = (tray_for_cartridge(device), device.get("id"))
    return mapping


def _start_date(request: dict) -> str:
    """authoredOn bounds slot generation (FHIR-MAPPING.md §2, med start anchor)."""
    authored = request.get("authoredOn")
    if authored:
        return authored[:10]
    last_updated = (request.get("meta") or {}).get("lastUpdated")
    return last_updated[:10] if last_updated else ""


def build_day_slots(
    requests: list[dict],
    cartridges: list[dict],
    medication_displays: dict[str, str],
    day: date,
    tz,
    dispenser_id: str | None = None,
) -> list[DoseSlot]:
    """One DoseSlot per (active request x dosageInstruction x timeOfDay) for
    `day`, sorted by scheduled time then identity.

    `tz` anchors slots to the owner's local day — the same local-date
    convention the frontend uses (identifiers carry local dates, so both
    sides must agree or the same physical dose gets two identities).
    Pure function: no I/O, no clock; raises ValueError on a timeOfDay
    missing seconds rather than guessing (fail loudly at schedule-build,
    not at write time). PRN meds have no timeOfDay -> no slots here; PRN
    logging is app-side only (client event UUID identity, §3).
    """
    trays = map_trays(cartridges, dispenser_id)
    day_str = day.isoformat()
    slots: list[DoseSlot] = []
    for request in requests:
        if request.get("status") != "active":
            continue
        # authoredOn is the med-start anchor (FHIR-MAPPING.md §2): meds added
        # mid-history must not generate phantom "missed" slots for days
        # before they existed.
        start = _start_date(request)
        if start and day_str < start:
            continue  # med did not exist yet — no slots
        med_ref = (request.get("medicationReference") or {}).get("reference", "")
        display = (request.get("medicationReference") or {}).get("display") or medication_displays.get(
            med_ref, med_ref or "Medication"
        )
        # Owner-set life-critical flag (CLAUDE.md §8) — carried through so
        # downstream consumers can sort/flag critical gaps first. Never
        # inferred, and never used to gate anything here.
        life_critical = any(
            ext.get("url", "").endswith("medicationrequest-life-critical") and ext.get("valueBoolean")
            for ext in request.get("extension", [])
        )
        tray, cartridge_id = trays.get(med_ref, (None, None))
        for dosage in request.get("dosageInstruction", []):
            repeat = ((dosage.get("timing") or {}).get("repeat")) or {}
            for time_of_day in repeat.get("timeOfDay", []):
                parsed = parse_time_of_day(time_of_day)
                slots.append(
                    DoseSlot(
                        scheduled=datetime.combine(day, parsed, tz),
                        date=day_str,
                        time=time_of_day,
                        request_id=request.get("id", ""),
                        request_slug=request_slug(request),
                        medication_ref=med_ref,
                        medication_display=display,
                        life_critical=life_critical,
                        tray=tray,
                        cartridge_id=cartridge_id,
                    )
                )
    return sorted(slots, key=lambda s: (s.scheduled, s.ident_value))


def fetch_regimen(client, patient_id: str) -> Regimen:
    """Pull the live regimen from Medplum (typed params, server-side filters).

    Reads: active MedicationRequests for the Patient, active cartridge +
    pill-dispenser Devices (by local type code), then each referenced
    Medication for its display text. Read-only; raises MedplumError when the
    server is unreachable (cli.cmd_status turns that into exit code 1).
    _count bounds (100 meds / 50 cartridges / 5 dispensers) are far above a
    single-user regimen — Medplum's default _count of 20 is the thing being
    overridden (CLAUDE.md §5 search facts). First dispenser wins if several
    exist; multi-dispenser homes are out of scope for Phase 8.
    """
    from .consts import CS_DEVICE

    regimen = Regimen()
    regimen.requests = client.search_resources(
        "MedicationRequest",
        {"status": "active", "subject": f"Patient/{patient_id}", "_count": "100"},
    )
    regimen.cartridges = client.search_resources(
        "Device",
        {"type": f"{CS_DEVICE}|{DEVICE_CARTRIDGE}", "status": "active", "_count": "50"},
    )
    dispensers = client.search_resources(
        "Device",
        {"type": f"{CS_DEVICE}|{DEVICE_DISPENSER}", "status": "active", "_count": "5"},
    )
    regimen.dispenser = dispensers[0] if dispensers else None

    med_refs = {
        (r.get("medicationReference") or {}).get("reference")
        for r in regimen.requests
        if (r.get("medicationReference") or {}).get("reference")
    }
    for ref in sorted(med_refs):
        med = client.get(ref)
        regimen.medication_displays[ref] = (med.get("code") or {}).get("text", ref)
    return regimen
