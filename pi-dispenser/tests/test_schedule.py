"""schedule.py: slot building from fixture MedicationRequests + cartridges.

The first test pins the CROSS-PACKAGE identifier convention (`ident_value`
must equal frontend slotIdentValue / seed.py exactly — see schedule.py's
module docstring); the rest cover tray mapping via extension + Device.parent,
the authoredOn start anchor, seconds-required timeOfDay, and the owner-set
life-critical flag passthrough."""

from datetime import date, timezone

import pytest

from fixtures import cartridge, medication_request
from pi_dispenser.schedule import build_day_slots, parse_time_of_day

UTC = timezone.utc
DAY = date(2026, 7, 15)
DISPLAYS = {"Medication/med-a": "Med A", "Medication/med-b": "Med B"}


def test_builds_sorted_slots_with_frontend_identifier_convention():
    requests = [
        medication_request("sample-med-b-bid", "med-b", "Med B", ["09:00:00", "21:00:00"]),
        medication_request("sample-med-a-daily", "med-a", "Med A", ["09:00:00"]),
    ]
    slots = build_day_slots(requests, [], DISPLAYS, DAY, UTC)
    assert [s.ident_value for s in slots] == [
        "sample-med-a-daily-2026-07-15T09:00",  # matches frontend slotIdentValue + seed.py exactly
        "sample-med-b-bid-2026-07-15T09:00",
        "sample-med-b-bid-2026-07-15T21:00",
    ]
    assert slots[0].scheduled.hour == 9
    assert slots[2].scheduled.hour == 21
    assert all(s.date == "2026-07-15" for s in slots)


def test_time_of_day_requires_seconds():
    requests = [medication_request("r", "med-a", "Med A", ["09:00"])]
    with pytest.raises(ValueError, match=r'requires seconds \("09:00:00"\)'):
        build_day_slots(requests, [], DISPLAYS, DAY, UTC)


def test_tray_mapping_via_extension_and_parent():
    requests = [medication_request("sample-med-a-daily", "med-a", "Med A", ["09:00:00"])]
    carts = [
        cartridge("cart-9", "cartridge-9", "med-b"),  # other med — irrelevant
        cartridge("cart-3", "cartridge-3", "med-a"),  # ours, tray 3
    ]
    (slot,) = build_day_slots(requests, carts, DISPLAYS, DAY, UTC, dispenser_id="dispenser-1")
    assert slot.tray == 3
    assert slot.cartridge_id == "cart-3"


def test_cartridge_on_a_different_dispenser_is_excluded():
    requests = [medication_request("sample-med-a-daily", "med-a", "Med A", ["09:00:00"])]
    carts = [cartridge("cart-1", "cartridge-1", "med-a", parent_id="someone-elses-dispenser")]
    (slot,) = build_day_slots(requests, carts, DISPLAYS, DAY, UTC, dispenser_id="dispenser-1")
    assert slot.tray is None
    assert slot.cartridge_id is None


def test_authored_on_bounds_slot_generation():
    not_yet = medication_request("future-med", "med-a", "Med A", ["09:00:00"], authoredOn="2026-08-01")
    inactive = medication_request("stopped-med", "med-b", "Med B", ["09:00:00"], status="stopped")
    assert build_day_slots([not_yet, inactive], [], DISPLAYS, DAY, UTC) == []


def test_life_critical_flag_carried_through():
    request = medication_request(
        "critical-med",
        "med-a",
        "Med A",
        ["09:00:00"],
        extension=[
            {
                "url": "https://healmedaily.local/fhir/StructureDefinition/medicationrequest-life-critical",
                "valueBoolean": True,
            }
        ],
    )
    (slot,) = build_day_slots([request], [], DISPLAYS, DAY, UTC)
    assert slot.life_critical is True


def test_only_first_dosage_instruction_expands():
    # The frontend (fhir.ts) and iOS both read dosageInstruction[0]; the
    # dispenser must too, or a multi-instruction request would generate slots
    # the app never shows/logs and the two would diverge on the same regimen.
    request = medication_request("multi-med", "med-a", "Med A", ["09:00:00"])
    request["dosageInstruction"].append(
        {"text": "second schedule", "timing": {"repeat": {"timeOfDay": ["21:00:00"]}}}
    )
    slots = build_day_slots([request], [], DISPLAYS, DAY, UTC)
    assert [s.time for s in slots] == ["09:00:00"]  # 21:00 from the 2nd instruction ignored


def test_authored_on_datetime_uses_local_calendar_date():
    # An evening-local authoredOn dateTime that is "tomorrow" in UTC must still
    # count as started for the local day (matches the frontend's localCalendarDate).
    from datetime import timedelta, timezone as tzmod

    minus5 = tzmod(timedelta(hours=-5))
    # 2026-07-15 22:00 -05:00 == 2026-07-16 03:00 UTC; local start date is the 15th.
    req = medication_request("evening-med", "med-a", "Med A", ["09:00:00"], authoredOn="2026-07-16T03:00:00Z")
    slots = build_day_slots([req], [], DISPLAYS, DAY, minus5)  # DAY = 2026-07-15
    assert [s.time for s in slots] == ["09:00:00"]  # started on the 15th local, so a slot exists


def test_parse_time_of_day_valid():
    parsed = parse_time_of_day("19:30:00")
    assert (parsed.hour, parsed.minute, parsed.second) == (19, 30, 0)
