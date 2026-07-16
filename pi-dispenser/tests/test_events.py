"""FHIR writers: identifier idempotency + §9 shapes."""

from datetime import datetime, timezone

import pytest

from pi_dispenser.consts import (
    CS_ADHERENCE,
    CS_ESCALATION,
    EXT_VERIFICATION,
    IDENT_ADMIN,
    IDENT_COMM_REQ,
    IDENT_DISPENSE,
)
from pi_dispenser.events import dispense_event, escalation_event, missed_event, pickup_event
from pi_dispenser.schedule import DoseSlot

UTC = timezone.utc
T0 = datetime(2026, 7, 15, 9, 0, 0, tzinfo=UTC)

SLOT = DoseSlot(
    scheduled=T0,
    date="2026-07-15",
    time="09:00:00",
    request_id="req-a",
    request_slug="sample-med-a-daily",
    medication_ref="Medication/med-a",
    medication_display="Med A",
    tray=1,
    cartridge_id="cart-1",
)


def test_dispense_event_shape_and_identifier():
    resource = dispense_event(SLOT, "pat-1", "disp-1", when_handed_over=T0)
    assert resource["resourceType"] == "MedicationDispense"
    assert resource["status"] == "completed"
    assert resource["identifier"] == [{"system": IDENT_DISPENSE, "value": "sample-med-a-daily-2026-07-15T09:00"}]
    assert resource["authorizingPrescription"] == [{"reference": "MedicationRequest/req-a"}]
    assert resource["whenHandedOver"] == T0.isoformat()
    assert resource["performer"][0]["actor"]["reference"] == "Device/disp-1"


def test_identifiers_are_idempotent_across_retries():
    a = dispense_event(SLOT, "pat-1", "disp-1", when_handed_over=T0)
    b = dispense_event(SLOT, "pat-1", "disp-1", when_handed_over=T0)
    assert a["identifier"] == b["identifier"]
    p1 = pickup_event(SLOT, "pat-1", "disp-1", T0, "weight")
    p2 = pickup_event(SLOT, "pat-1", "disp-1", T0, "weight")
    assert p1["identifier"] == p2["identifier"]
    # dispense and administration are distinct events on distinct systems
    assert a["identifier"][0]["system"] != p1["identifier"][0]["system"]


def test_pickup_event_is_the_section3_logical_dose_event():
    effective = datetime(2026, 7, 15, 9, 4, 0, tzinfo=UTC)
    resource = pickup_event(SLOT, "pat-1", "disp-1", effective, "weight")
    assert resource["resourceType"] == "MedicationAdministration"
    assert resource["status"] == "completed"
    # identifier = request + scheduled occurrence — same value a manual app tap uses
    assert resource["identifier"] == [{"system": IDENT_ADMIN, "value": "sample-med-a-daily-2026-07-15T09:00"}]
    assert resource["effectiveDateTime"] == effective.isoformat()
    assert resource["request"] == {"reference": "MedicationRequest/req-a"}
    assert {"reference": "Device/cart-1"} in resource["device"]
    assert {"reference": "Device/disp-1"} in resource["device"]
    assert resource["extension"] == [{"url": EXT_VERIFICATION, "valueCode": "weight"}]


@pytest.mark.parametrize("verification", ["weight", "camera", "self"])
def test_pickup_event_accepts_each_verification_code(verification):
    resource = pickup_event(SLOT, "pat-1", "disp-1", T0, verification)
    assert resource["extension"][0]["valueCode"] == verification


def test_pickup_event_rejects_unknown_verification():
    with pytest.raises(ValueError, match="verification"):
        pickup_event(SLOT, "pat-1", "disp-1", T0, "guess")


def test_escalation_event_shape():
    at = datetime(2026, 7, 15, 9, 15, 0, tzinfo=UTC)
    resource = escalation_event(SLOT, "pat-1", "disp-1", medium="push", at=at, note="still in tray")
    assert resource["resourceType"] == "CommunicationRequest"
    assert resource["status"] == "active"
    assert resource["identifier"] == [{"system": IDENT_COMM_REQ, "value": "sample-med-a-daily-2026-07-15T09:00-push"}]
    assert resource["medium"][0]["coding"] == [{"system": CS_ESCALATION, "code": "push"}]
    assert resource["occurrenceDateTime"] == at.isoformat()
    assert resource["about"] == [{"reference": "MedicationRequest/req-a"}]
    assert "recipient" not in resource  # no family alert unless configured


def test_missed_event_is_a_transaction_with_dispenser_provenance():
    at = datetime(2026, 7, 15, 11, 0, 0, tzinfo=UTC)
    bundle = missed_event(SLOT, "pat-1", "disp-1", at=at)
    assert bundle["resourceType"] == "Bundle"
    assert bundle["type"] == "transaction"
    admin_entry, prov_entry = bundle["entry"]

    admin = admin_entry["resource"]
    assert admin["status"] == "not-done"
    reason = admin["statusReason"][0]["coding"][0]
    assert reason == {"system": CS_ADHERENCE, "code": "user-marked-missed", "display": "Marked missed by user"}
    assert admin["identifier"] == [{"system": IDENT_ADMIN, "value": "sample-med-a-daily-2026-07-15T09:00"}]
    assert admin_entry["request"]["ifNoneExist"] == f"identifier={IDENT_ADMIN}|sample-med-a-daily-2026-07-15T09:00"

    provenance = prov_entry["resource"]
    assert provenance["resourceType"] == "Provenance"
    assert provenance["target"] == [{"reference": admin_entry["fullUrl"]}]
    assert provenance["agent"][0]["who"]["reference"] == "Device/disp-1"

    # deterministic across retries — replaying the bundle stays conditional
    again = missed_event(SLOT, "pat-1", "disp-1", at=at)
    assert again["entry"][0]["fullUrl"] == admin_entry["fullUrl"]
