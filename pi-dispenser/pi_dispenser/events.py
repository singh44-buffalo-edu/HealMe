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

Idempotency identifiers (FHIR-MAPPING.md §7; value format from
schedule.DoseSlot.ident_value = "{request-slug}-{YYYY-MM-DD}T{HH:MM}"):

    MedicationDispense        identifier/medication-dispense      | ident_value
    MedicationAdministration  identifier/medication-administration| ident_value
    CommunicationRequest      identifier/communication-request    | ident_value + "-{medium}"

Dispense and administration share the VALUE but live on different identifier
SYSTEMS — they are distinct moments (offered vs taken) of the same slot.
The administration identifier is the exact one the frontend's manual tap
uses, which is how machine and human converge on one logical dose event.

Layering: agent.py calls the builders (pure, no I/O) and hands the payloads
to a sink. DryRunSink prints; MedplumSink is the ONLY code path that writes
dispenser data to the record.
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
    """Wedge/tray drop at dose time -> MedicationDispense.

    `when_handed_over` is T0, the moment pills physically landed in the base
    tray — readers compute timeliness as administration.effectiveDateTime
    minus this (§9: computed, never stored). The dispenser Device is the
    performer; the MedicationRequest is the authorizing prescription."""
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

    `effective` is the observed pickup moment (clinical time, not write
    time); `verification` must be one of weight|camera|self — how the pickup
    was confirmed, chosen by agent.choose_verification (weight > camera >
    self, §9) — and lands in the administration-verification extension.
    Device references (cartridge + dispenser) record which hardware served
    the dose. Timeliness is effectiveDateTime - whenHandedOver: computed by
    readers, never stored (§9). Raises ValueError on an unknown verification
    code rather than writing an unlabeled confirmation.
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
    completed Communication later; that is the app's job, not ours).

    `medium` is the rung's local escalation code (chime/push/ask-why —
    ladder.py); it is part of the identifier ("{ident_value}-{medium}"), so
    re-firing the same rung for the same slot is a no-op while different
    rungs of one slot stay distinct (§7 "request + occurrence + rung").
    `recipient` is ONLY ever set for the owner-configured family alert —
    absent by default (no family alerts unless opted in)."""
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
    NEVER call it unless the configured final rung says to log.

    Transaction bundle (CLAUDE.md §6 multi-resource rule) so administration
    and its Provenance land atomically; the admin entry is itself
    conditional (ifNoneExist), keeping the §3 rule that a user's own log
    always wins over the machine's."""
    # uuid5 (not uuid4): the fullUrl is derived from the dose identity, so a
    # retried/replayed bundle is byte-identical and the Provenance target
    # still resolves — deterministic replay, pinned by test_events.py.
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
#
# Sink contract: submit(payload: dict) -> None. The agent is sink-agnostic;
# cli.py picks MedplumSink when DISPENSER_MEDPLUM_* is configured (and
# --dry-run is off), else DryRunSink. Tests always use DryRunSink.


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
    """Collects payloads and prints them — no Medplum required.

    The default when credentials are absent (the package must be fully
    usable with zero configuration, like the app's no-AI-key rule). The
    collected `payloads` list is what the e2e tests assert against."""

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
        # Missed-dose bundle: pre-check whether ANY administration already
        # exists for this slot (any status — a user's tap/skip beats the
        # machine's "missed"), then post the transaction. The pre-check plus
        # the entry's own ifNoneExist covers the race where a log lands
        # between check and POST.
        if payload.get("resourceType") == "Bundle":
            admin = payload["entry"][0]["resource"]
            if self._existing("MedicationAdministration", admin["identifier"][0]):
                self._out(f"[fhir] dose event already logged — skipping: {describe(admin)}")
                return
            self._client.post_bundle(payload)
            self._out(f"[fhir] committed {describe(payload)}")
            return

        ident = payload["identifier"][0]
        # Administrations may legitimately exist already (user skipped in the
        # app, then picked up from the tray): same status -> no-op replay;
        # different status -> version-checked update of the SAME logical
        # event, never a second resource (§3 skipped->taken rule).
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
        # Everything else (dispense, escalation, first-time administration):
        # plain conditional create on the stable identifier.
        self._client.create_if_none_exist(payload, f"identifier={ident['system']}|{ident['value']}")
        self._out(f"[fhir] committed {describe(payload)}")
