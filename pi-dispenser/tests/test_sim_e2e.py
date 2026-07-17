"""End-to-end: full simulated days through the real agent/HAL/ladder stack,
FHIR output captured via DryRunSink (nothing written anywhere).

Covers the safety-critical behaviors as whole-day sequences: the expected
event order for the sample day, the full ladder walk with the default
missed log, NO resource when the owner's config says not to log, family
alert only when explicitly configured, the weight > camera > self
verification fallbacks, and webhook failures never affecting the FHIR
stream. speed=0 means zero real sleeping — a "day" runs in milliseconds."""

import json
from copy import deepcopy
from datetime import date, datetime, time as dtime, timezone
from pathlib import Path

from pi_dispenser.agent import DispenserAgent, choose_verification
from pi_dispenser.consts import EXT_VERIFICATION
from pi_dispenser.events import DryRunSink
from pi_dispenser.hal import SimClock, SimulatedBackend
from pi_dispenser.ladder import LadderConfig

SCENARIO_PATH = Path(__file__).resolve().parents[1] / "scenarios" / "day.json"


def load_scenario() -> dict:
    return json.loads(SCENARIO_PATH.read_text())


def run_scenario(scenario: dict, ladder: LadderConfig | None = None, webhook=None, webhook_url=None):
    from pi_dispenser.cli import _scenario_slots

    tz = timezone.utc
    day = date.fromisoformat(scenario["date"])
    slots, patient_id, dispenser_id = _scenario_slots(scenario, tz)
    clock = SimClock(datetime.combine(day, dtime(0, 0, 0), tz), speed=0)  # no real sleeping in tests
    backend = SimulatedBackend(scenario, clock, day, out=lambda _msg: None)
    sink = DryRunSink(out=lambda _msg: None, print_payloads=False)
    agent = DispenserAgent(
        backend=backend,
        clock=clock,
        sink=sink,
        patient_id=patient_id,
        dispenser_id=dispenser_id,
        ladder_config=ladder,
        webhook_url=webhook_url,
        webhook_poster=webhook or (lambda url, payload: None),
        out=lambda _msg: None,
    )
    agent.run_day(slots)
    return sink.payloads, backend


def brief(payload: dict) -> tuple:
    rt = payload["resourceType"]
    if rt == "Bundle":
        return ("Bundle", payload["entry"][0]["resource"]["identifier"][0]["value"])
    return (rt, payload["identifier"][0]["value"])


def verification_of(admin: dict) -> str:
    return next(e["valueCode"] for e in admin["extension"] if e["url"] == EXT_VERIFICATION)


def test_sample_day_produces_the_expected_fhir_sequence():
    payloads, _backend = run_scenario(load_scenario())
    assert [brief(p) for p in payloads] == [
        ("MedicationDispense", "sample-med-a-daily-2026-07-15T09:00"),
        ("CommunicationRequest", "sample-med-a-daily-2026-07-15T09:00-chime"),
        ("MedicationAdministration", "sample-med-a-daily-2026-07-15T09:00"),
        ("MedicationDispense", "sample-med-b-evening-2026-07-15T19:00"),
        ("CommunicationRequest", "sample-med-b-evening-2026-07-15T19:00-chime"),
        ("CommunicationRequest", "sample-med-b-evening-2026-07-15T19:00-push"),
        ("MedicationAdministration", "sample-med-b-evening-2026-07-15T19:00"),
    ]

    morning = payloads[2]
    assert morning["status"] == "completed"
    assert verification_of(morning) == "weight"
    assert morning["effectiveDateTime"].endswith("09:04:00+00:00")  # exact pickup moment

    evening = payloads[6]
    assert verification_of(evening) == "weight"
    assert evening["effectiveDateTime"].endswith("19:22:00+00:00")  # after the T+15 rung

    push = payloads[5]
    assert push["occurrenceDateTime"].endswith("19:15:00+00:00")  # T+15 exactly
    # no ask-why, no missed log — the dose was picked up before T+45
    assert not any(brief(p)[1].endswith("ask-why") for p in payloads)
    assert not any(p["resourceType"] == "Bundle" for p in payloads)


def test_unpicked_dose_walks_the_full_ladder_and_logs_missed_by_default():
    scenario = deepcopy(load_scenario())
    scenario["pickups"] = []
    payloads, backend = run_scenario(scenario)

    morning = [p for p in payloads if "sample-med-a-daily" in brief(p)[1]]
    assert [brief(p)[0] for p in morning] == [
        "MedicationDispense",
        "CommunicationRequest",  # T+0 chime
        "CommunicationRequest",  # T+15 push
        "CommunicationRequest",  # T+45 ask-why
        "Bundle",  # T+2h close-tray -> not-done + Provenance (default config logs it)
    ]
    bundle = morning[-1]
    admin = bundle["entry"][0]["resource"]
    assert admin["status"] == "not-done"
    assert admin["statusReason"][0]["coding"][0]["code"] == "user-marked-missed"
    assert admin["effectiveDateTime"].endswith("11:00:00+00:00")  # T0 09:00 + 2h
    assert backend.base_tray_retracted is True
    # no family alert by default — no CommunicationRequest has a recipient
    assert not any(p.get("recipient") for p in payloads if p["resourceType"] == "CommunicationRequest")


def test_final_rung_logs_nothing_when_the_user_config_says_no():
    scenario = deepcopy(load_scenario())
    scenario["pickups"] = []
    config = LadderConfig.from_dict({"log_missed_at_final_rung": False})
    payloads, backend = run_scenario(scenario, ladder=config)
    # tray still closes, but NO missed-dose resource exists (§3: no log => no resource)
    assert backend.base_tray_retracted is True
    assert not any(p["resourceType"] == "Bundle" for p in payloads)
    assert not any(p["resourceType"] == "MedicationAdministration" for p in payloads)


def test_family_alert_fires_only_when_explicitly_configured():
    scenario = deepcopy(load_scenario())
    scenario["pickups"] = []
    config = LadderConfig.from_dict({"family_alert_recipient": "RelatedPerson/ma"})
    payloads, _backend = run_scenario(scenario, ladder=config)
    alerts = [p for p in payloads if p["resourceType"] == "CommunicationRequest" and p.get("recipient")]
    assert len(alerts) == 2  # one per unpicked dose, at the final rung
    assert alerts[0]["recipient"] == [{"reference": "RelatedPerson/ma"}]


def test_verification_priority_weight_over_camera_over_self():
    assert choose_verification(True, True) == "weight"
    assert choose_verification(True, False) == "weight"
    assert choose_verification(False, True) == "camera"
    assert choose_verification(False, False) == "self"


def test_camera_fallback_when_load_cell_is_out():
    scenario = deepcopy(load_scenario())
    scenario["hardware"]["load_cell"] = False  # camera still available
    payloads, _backend = run_scenario(scenario)
    admins = [p for p in payloads if p["resourceType"] == "MedicationAdministration"]
    assert len(admins) == 2
    assert all(verification_of(a) == "camera" for a in admins)
    assert all(a["status"] == "completed" for a in admins)


def test_self_report_when_no_sensor_can_verify():
    scenario = deepcopy(load_scenario())
    scenario["hardware"]["load_cell"] = False
    scenario["hardware"]["camera"] = False
    scenario["pickups"] = [{"at": "09:04:00", "via": "tap"}, {"at": "19:22:00", "via": "tap"}]
    payloads, _backend = run_scenario(scenario)
    admins = [p for p in payloads if p["resourceType"] == "MedicationAdministration"]
    assert len(admins) == 2
    assert all(verification_of(a) == "self" for a in admins)


def test_unmapped_med_is_a_reminder_not_a_wrong_tray_dispense():
    # A med with no cartridge mapped must NOT rotate to a default tray and drop
    # another med's pills. Clearing cartridges makes both slots tray-less; the
    # agent should emit reminders and physically dispense nothing.
    scenario = deepcopy(load_scenario())
    scenario["cartridges"] = []
    events: list[dict] = []
    payloads, backend = run_scenario(
        scenario, webhook=lambda url, p: events.append(p), webhook_url="http://lan.local/hook"
    )
    # No MedicationDispense and no MedicationAdministration: the guard returns
    # before both the spindle rotate and the dispense event (agent._dispense).
    assert not any(p["resourceType"] in ("MedicationDispense", "MedicationAdministration") for p in payloads)
    assert [e["event"] for e in events].count("reminder-unmapped") == 2


def test_webhook_fires_on_state_changes_and_failures_never_break_the_run():
    events: list[dict] = []

    def recorder(url: str, payload: dict) -> None:
        assert url == "http://lan.local/hook"
        events.append(payload)

    payloads, _ = run_scenario(load_scenario(), webhook=recorder, webhook_url="http://lan.local/hook")
    kinds = [e["event"] for e in events]
    assert kinds.count("dispensed") == 2
    assert kinds.count("picked-up") == 2
    assert "escalation" in kinds

    def broken(url: str, payload: dict) -> None:
        raise ConnectionError("LAN down")

    # must complete the identical FHIR sequence even when every webhook POST fails
    payloads_broken, _ = run_scenario(load_scenario(), webhook=broken, webhook_url="http://lan.local/hook")
    assert [brief(p) for p in payloads_broken] == [brief(p) for p in payloads]
