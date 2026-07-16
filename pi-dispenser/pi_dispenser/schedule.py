"""Build today's dose slots from active MedicationRequests + cartridge Devices.

Slot identity matches the frontend (frontend/src/fhir.ts slotIdentValue) and
seed.py exactly, so a dispenser pickup updates the SAME logical dose event a
manual tap in the app would create:

    identifier system  https://healmedaily.local/fhir/identifier/medication-administration
    identifier value   {request-slug}-{YYYY-MM-DD}T{HH:MM}

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
    scheduled: datetime  # tz-aware local occurrence
    date: str  # YYYY-MM-DD
    time: str  # HH:MM:SS
    request_id: str
    request_slug: str
    medication_ref: str
    medication_display: str
    life_critical: bool = False
    tray: int | None = None
    cartridge_id: str | None = None

    @property
    def ident_value(self) -> str:
        """Stable dose-event identity: request + scheduled occurrence (§3)."""
        return f"{self.request_slug}-{self.date}T{self.time[:5]}"


@dataclass
class Regimen:
    requests: list[dict] = field(default_factory=list)
    cartridges: list[dict] = field(default_factory=list)
    medication_displays: dict[str, str] = field(default_factory=dict)  # "Medication/x" -> text
    dispenser: dict | None = None


def request_slug(request: dict) -> str:
    for ident in request.get("identifier", []):
        if ident.get("system") == IDENT_REQUEST and ident.get("value"):
            return ident["value"]
    return request.get("id", "unknown-request")


def _trailing_int(text: str | None) -> int | None:
    match = re.search(r"(\d+)\s*$", text or "")
    return int(match.group(1)) if match else None


def tray_for_cartridge(device: dict) -> int | None:
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
    for ext in device.get("extension", []):
        if ext.get("url") == EXT_DEVICE_MED:
            return (ext.get("valueReference") or {}).get("reference")
    return None


def map_trays(cartridges: list[dict], dispenser_id: str | None) -> dict[str, tuple[int | None, str | None]]:
    """medication reference -> (tray number, cartridge Device id).

    When a dispenser id is known, only cartridges mounted on it
    (Device.parent) or not yet mounted anywhere (legacy pre-Phase-8 seeds)
    are considered; cartridges on a *different* dispenser are excluded.
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
    trays = map_trays(cartridges, dispenser_id)
    day_str = day.isoformat()
    slots: list[DoseSlot] = []
    for request in requests:
        if request.get("status") != "active":
            continue
        start = _start_date(request)
        if start and day_str < start:
            continue  # med did not exist yet — no slots
        med_ref = (request.get("medicationReference") or {}).get("reference", "")
        display = (request.get("medicationReference") or {}).get("display") or medication_displays.get(
            med_ref, med_ref or "Medication"
        )
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
    """Pull the live regimen from Medplum (typed params, server-side filters)."""
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
