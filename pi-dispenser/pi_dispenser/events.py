"""FHIR writers for dispenser events — FHIR-MAPPING.md §9, followed exactly.

| Event                    | Resource                                                   |
| ------------------------ | ---------------------------------------------------------- |
| Wedge drop at dose time  | MedicationDispense (completed, whenHandedOver=T0)           |
| Pickup / confirmed intake| MedicationAdministration — the SAME logical dose event as   |
|                          | §3 (identifier = request + scheduled occurrence) with the   |
|                          | administration-verification extension (weight|camera|self)  |
| Escalation rung          | CommunicationRequest (medium local chime/push/ask-why)      |
| Final-rung missed log    | MedicationAdministration not-done + user-marked-missed,     |
|                          | written ONLY when the user-configured ladder says so, in a  |
|                          | transaction with a Provenance attributing the dispenser     |

The dispenser writes dose events ONLY — never Conditions/Observations, and
telemetry (load cell, sensors) never reaches the record. All writes are
idempotent: stable identifiers + conditional create (ifNoneExist).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from datetime import datetime

from .consts import (
    CS_ADHERENCE,
    CS_ESCALATION,
    EXT_VERIFICATION,
    IDENT_ADMIN,
    IDENT_COMM_REQ,
    IDENT_DISPENSE,
    PROVENANCE_PARTICIPANT_TYPE,
    VERIFICATIONS,
)
from .schedule import DoseSlot

# ---------------------------------------------------------------------------
# Payload builders (pure functions -> plain dicts)
# ---------------------------------------------------------------------------


def _patient_ref(patient_id: str) -> dict:
    return {"reference": f"Patient/{patient_id}"}


def _med_ref(slot: DoseSlot) -> dict:
    return {"reference": slot.medication_ref, "display": slot.medication_display}


def dispense_event(slot: DoseSlot, patient_id: str, dispenser_id: str, when_handed_over: datetime) -> dict:
    """Wedge/tray drop at dose time -> MedicationDispense."""
    return {
        "resourceType": "MedicationDispense",
        "identifier": [{"system": IDENT_DISPENSE, "value": slot.ident_value}],
        "status": "completed",
        "subject": _patient_ref(patient_id),
        "medicationReference": _med_ref(slot),
        "authorizingPrescription": [{"reference": f"MedicationRequest/{slot.request_id}"}],
        "whenHandedOver": when_handed_over.isoformat(),
        "performer": [{"actor": {"reference": f"Device/{dispenser_id}", "display": "HealMeDaily pill dispenser"}}],
    }


def pickup_event(
    slot: DoseSlot,
    patient_id: str,
    dispenser_id: str,
    effective: datetime,
    verification: str,
) -> dict:
    """Pickup / confirmed intake -> the §3 logical dose event, completed.

    Timeliness is effectiveDateTime - whenHandedOver: computed by readers,
    never stored (§9).
    """
    if verification not in VERIFICATIONS:
        raise ValueError(f"verification must be one of {VERIFICATIONS}, got {verification!r}")
    devices = [{"reference": f"Device/{d}"} for d in (slot.cartridge_id, dispenser_id) if d]
    resource = {
        "resourceType": "MedicationAdministration",
        "identifier": [{"system": IDENT_ADMIN, "value": slot.ident_value}],
        "extension": [{"url": EXT_VERIFICATION, "valueCode": verification}],
        "status": "completed",
        "subject": _patient_ref(patient_id),
        "medicationReference": _med_ref(slot),
        "request": {"reference": f"MedicationRequest/{slot.request_id}"},
        "effectiveDateTime": effective.isoformat(),
    }
    if devices:
        resource["device"] = devices
    return resource


def escalation_event(
    slot: DoseSlot,
    patient_id: str,
    dispenser_id: str,
    medium: str,
    at: datetime,
    note: str = "",
    recipient: str | None = None,
) -> dict:
    """One escalation rung -> CommunicationRequest (delivery marks it a
    completed Communication later; that is the app's job, not ours)."""
    resource = {
        "resourceType": "CommunicationRequest",
        "identifier": [{"system": IDENT_COMM_REQ, "value": f"{slot.ident_value}-{medium}"}],
        "status": "active",
        "subject": _patient_ref(patient_id),
        "medium": [{"coding": [{"system": CS_ESCALATION, "code": medium}], "text": medium}],
        "occurrenceDateTime": at.isoformat(),
        "about": [{"reference": f"MedicationRequest/{slot.request_id}"}],
        "requester": {"reference": f"Device/{dispenser_id}", "display": "HealMeDaily pill dispenser"},
    }
    if note:
        resource["payload"] = [{"contentString": note}]
    if recipient:
        resource["recipient"] = [{"reference": recipient}]
    return resource


def missed_event(slot: DoseSlot, patient_id: str, dispenser_id: str, at: datetime) -> dict:
    """Final-rung missed log -> transaction: MedicationAdministration
    not-done (user-marked-missed) + Provenance attributing the write to the
    dispenser agent (§9). Callers gate this on the user's ladder config —
    NEVER call it unless the configured final rung says to log."""
    full_url = f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, IDENT_ADMIN + '|' + slot.ident_value)}"
    admin = {
        "resourceType": "MedicationAdministration",
        "identifier": [{"system": IDENT_ADMIN, "value": slot.ident_value}],
        "status": "not-done",
        "statusReason": [
            {
                "coding": [{"system": CS_ADHERENCE, "code": "user-marked-missed", "display": "Marked missed by user"}],
                "text": "No pickup by the final escalation rung — logged per your escalation settings",
            }
        ],
        "subject": _patient_ref(patient_id),
        "medicationReference": _med_ref(slot),
        "request": {"reference": f"MedicationRequest/{slot.request_id}"},
        "effectiveDateTime": at.isoformat(),
    }
    if slot.cartridge_id or dispenser_id:
        admin["device"] = [{"reference": f"Device/{d}"} for d in (slot.cartridge_id, dispenser_id) if d]
    provenance = {
        "resourceType": "Provenance",
        "target": [{"reference": full_url}],
        "recorded": at.isoformat(),
        "agent": [
            {
                "type": {"coding": [{"system": PROVENANCE_PARTICIPANT_TYPE, "code": "performer"}]},
                "who": {"reference": f"Device/{dispenser_id}", "display": "HealMeDaily pill dispenser"},
            }
        ],
    }
    return {
        "resourceType": "Bundle",
        "type": "transaction",
        "entry": [
            {
                "fullUrl": full_url,
                "resource": admin,
                "request": {
                    "method": "POST",
                    "url": "MedicationAdministration",
                    "ifNoneExist": f"identifier={IDENT_ADMIN}|{slot.ident_value}",
                },
            },
            {"resource": provenance, "request": {"method": "POST", "url": "Provenance"}},
        ],
    }


# ---------------------------------------------------------------------------
# Sinks — where payloads go
# ---------------------------------------------------------------------------


def describe(payload: dict) -> str:
    """One line per event for logs and the dry-run stream."""
    rt = payload.get("resourceType")
    if rt == "Bundle":
        inner = payload["entry"][0]["resource"]
        return f"Bundle(transaction): {describe(inner)} + Provenance(dispenser agent)"
    ident = (payload.get("identifier") or [{}])[0].get("value", "?")
    if rt == "MedicationAdministration":
        verification = next(
            (e.get("valueCode") for e in payload.get("extension", []) if e.get("url") == EXT_VERIFICATION), None
        )
        detail = f"{payload.get('status')}" + (f", {verification}-verified" if verification else "")
        return f"MedicationAdministration [{ident}] {detail} @ {payload.get('effectiveDateTime')}"
    if rt == "MedicationDispense":
        return f"MedicationDispense [{ident}] {payload.get('status')} @ {payload.get('whenHandedOver')}"
    if rt == "CommunicationRequest":
        medium = payload.get("medium", [{}])[0].get("text", "?")
        return f"CommunicationRequest [{ident}] rung={medium} @ {payload.get('occurrenceDateTime')}"
    return f"{rt} [{ident}]"


class DryRunSink:
    """Collects payloads and prints them — no Medplum required."""

    def __init__(self, out: Callable[[str], None] = print, print_payloads: bool = True) -> None:
        self.payloads: list[dict] = []
        self._out = out
        self._print_payloads = print_payloads

    def submit(self, payload: dict) -> None:
        self.payloads.append(payload)
        self._out(f"[fhir dry-run] {describe(payload)}")
        if self._print_payloads:
            self._out(json.dumps(payload, indent=2))


class MedplumSink:
    """Writes to Medplum. Idempotent:

    - single resources: conditional create (If-None-Exist on the identifier);
      a MedicationAdministration whose status changed (skipped -> taken)
      updates the SAME logical event with an ifMatch version check (§3);
    - the missed-dose bundle: skipped entirely if the dose event already
      exists (a user log always wins over the machine), else posted as a
      transaction whose admin entry is itself conditional.
    """

    def __init__(self, client, out: Callable[[str], None] = print) -> None:
        self._client = client
        self._out = out

    def _existing(self, resource_type: str, ident: dict) -> dict | None:
        found = self._client.search_resources(
            resource_type, {"identifier": f"{ident['system']}|{ident['value']}", "_count": "1"}
        )
        return found[0] if found else None

    def submit(self, payload: dict) -> None:
        if payload.get("resourceType") == "Bundle":
            admin = payload["entry"][0]["resource"]
            if self._existing("MedicationAdministration", admin["identifier"][0]):
                self._out(f"[fhir] dose event already logged — skipping: {describe(admin)}")
                return
            self._client.post_bundle(payload)
            self._out(f"[fhir] committed {describe(payload)}")
            return

        ident = payload["identifier"][0]
        if payload["resourceType"] == "MedicationAdministration":
            existing = self._existing("MedicationAdministration", ident)
            if existing is not None:
                if existing.get("status") == payload.get("status"):
                    self._out(f"[fhir] already logged — no-op: {describe(payload)}")
                    return
                updated = {**payload, "id": existing["id"], "meta": existing.get("meta", {})}
                self._client.update_if_match(updated, existing.get("meta", {}).get("versionId"))
                self._out(f"[fhir] updated same logical dose event: {describe(payload)}")
                return
        self._client.create_if_none_exist(payload, f"identifier={ident['system']}|{ident['value']}")
        self._out(f"[fhir] committed {describe(payload)}")
