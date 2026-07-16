"""Shared FHIR fixtures for the dispenser tests (seed.py shapes)."""

from pi_dispenser.consts import CS_DEVICE, EXT_DEVICE_MED, IDENT_DEVICE, IDENT_REQUEST


def medication_request(slug: str, med_id: str, display: str, times: list[str], **overrides) -> dict:
    resource = {
        "resourceType": "MedicationRequest",
        "id": f"id-{slug}",
        "status": "active",
        "intent": "order",
        "authoredOn": "2026-04-16",
        "identifier": [{"system": IDENT_REQUEST, "value": slug}],
        "subject": {"reference": "Patient/patient-local"},
        "medicationReference": {"reference": f"Medication/{med_id}", "display": display},
        "dosageInstruction": [
            {
                "text": "test sig",
                "timing": {"repeat": {"frequency": len(times), "period": 1, "periodUnit": "d", "timeOfDay": times}},
            }
        ],
    }
    resource.update(overrides)
    return resource


def cartridge(device_id: str, slot_value: str, med_id: str, parent_id: str | None = "dispenser-1") -> dict:
    resource = {
        "resourceType": "Device",
        "id": device_id,
        "status": "active",
        "identifier": [{"system": IDENT_DEVICE, "value": slot_value}],
        "deviceName": [{"name": slot_value.replace("cartridge-", "Cartridge "), "type": "user-friendly-name"}],
        "type": {"coding": [{"system": CS_DEVICE, "code": "medication-cartridge"}]},
        "extension": [{"url": EXT_DEVICE_MED, "valueReference": {"reference": f"Medication/{med_id}"}}],
    }
    if parent_id:
        resource["parent"] = {"reference": f"Device/{parent_id}"}
    return resource
