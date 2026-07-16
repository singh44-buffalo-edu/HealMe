"""Command line interface.

    python -m pi_dispenser sim --scenario scenarios/day.json --speed 60
        Accelerated simulated day. Writes to Medplum when the
        DISPENSER_MEDPLUM_* env is configured, else dry-run mode printing
        every FHIR payload. --dry-run forces dry-run regardless.

    python -m pi_dispenser status
        Show configuration + Medplum connectivity + today's slots.

    python -m pi_dispenser run
        Real hardware loop (Raspberry Pi only; requires Medplum credentials).

This is the composition root: it is the only module that decides WHICH
backend/clock/sink the DispenserAgent gets. sim = SimulatedBackend +
SimClock (+ DryRunSink unless Medplum env is set); run = GpioBackend +
RealClock + MedplumSink; status only reads. The systemd unit
(systemd/pi-dispenser.service) execs `python -m pi_dispenser run` on the Pi.
Make targets: `make pi-sim` / `make pi-test` from the repo root.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, time as dtime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import schedule
from .agent import DispenserAgent
from .client import DispenserMedplumClient, MedplumError
from .events import DryRunSink, MedplumSink
from .hal import GpioBackend, RealClock, SimClock, SimulatedBackend
from .ladder import LadderConfig


def _tz(name: str):
    """Scenario `timezone` -> tzinfo: "local"/"" = machine zone, else IANA."""
    if name in ("", "local"):
        return datetime.now().astimezone().tzinfo
    return ZoneInfo(name)


def _load_scenario(path: str) -> dict:
    return json.loads(Path(path).read_text())


def _scenario_slots(scenario: dict, tz) -> tuple[list[schedule.DoseSlot], str, str]:
    """Slots + patient/dispenser ids from scenario fixtures (dry-run source).

    The fixture keys (medications / medication_requests / cartridges /
    dispenser) are real FHIR shapes — same builder as the live path, only
    the source differs. Also used by tests/test_sim_e2e.py."""
    day = date.fromisoformat(scenario["date"])
    displays = {
        f"Medication/{m['id']}": (m.get("code") or {}).get("text", m["id"]) for m in scenario.get("medications", [])
    }
    dispenser = scenario.get("dispenser") or {}
    dispenser_id = dispenser.get("id", "dispenser")
    slots = schedule.build_day_slots(
        scenario.get("medication_requests", []),
        scenario.get("cartridges", []),
        displays,
        day,
        tz,
        dispenser_id=dispenser_id,
    )
    return slots, scenario.get("patient_id", "patient-local"), dispenser_id


def _ladder(args) -> LadderConfig:
    return LadderConfig.from_file(args.ladder) if args.ladder else LadderConfig.default()


def cmd_sim(args) -> int:
    """Simulated day: scenario fixtures + SimClock, agent loop end to end.

    Exit 0 on a completed day. Writes to Medplum ONLY when credentials are
    configured and --dry-run is off; the default experience needs nothing
    installed or running (dry-run prints every payload instead)."""
    scenario = _load_scenario(args.scenario)
    tz = _tz(scenario.get("timezone", "local"))
    day = date.fromisoformat(scenario["date"])
    slots, patient_id, dispenser_id = _scenario_slots(scenario, tz)

    # Sink choice: real Medplum needs BOTH credentials and no --dry-run.
    # The env patient id overrides the scenario one so writes land on the
    # real Patient, not a fixture id.
    client = DispenserMedplumClient()
    if client.configured and not args.dry_run:
        sink = MedplumSink(client)
        patient_id = client.patient_id or patient_id
        print(f"[sim] writing events to Medplum at {client.base_url}")
    else:
        sink = DryRunSink(print_payloads=not args.quiet_payloads)
        print("[sim] dry-run mode — printing FHIR payloads, nothing is written")

    clock = SimClock(datetime.combine(day, dtime(0, 0, 0), tz), speed=args.speed, max_real_pause=1.0)
    backend = SimulatedBackend(scenario, clock, day)
    agent = DispenserAgent(
        backend=backend,
        clock=clock,
        sink=sink,
        patient_id=patient_id,
        dispenser_id=dispenser_id,
        ladder_config=_ladder(args),
        webhook_url=args.webhook,
    )
    print(f"[sim] simulated day {day.isoformat()} · speed x{args.speed:g} · {len(slots)} dose slot(s)")
    agent.run_day(slots)

    if isinstance(sink, DryRunSink):
        counts: dict[str, int] = {}
        for p in sink.payloads:
            counts[p["resourceType"]] = counts.get(p["resourceType"], 0) + 1
        summary = " · ".join(f"{v}x {k}" for k, v in sorted(counts.items()))
        print(f"[sim] dry-run complete — {len(sink.payloads)} FHIR event(s): {summary}")
    return 0


def cmd_status(args) -> int:
    """Read-only diagnostics: config, ladder, Medplum reachability, today's
    slots. Exit 1 only when credentials exist but Medplum is unreachable
    (unconfigured is a valid dry-run setup, not an error)."""
    client = DispenserMedplumClient()
    print("pi-dispenser status")
    print(f"  base url    : {client.base_url}")
    print(f"  credentials : {'configured' if client.configured else 'NOT configured (dry-run only)'}")
    print(f"  patient id  : {client.patient_id or '(unset)'}")
    ladder = _ladder(args)
    rungs = " -> ".join(f"T+{r.offset_minutes}m {r.action}" for r in ladder.rungs)
    print(f"  ladder      : {rungs}")
    print(f"  log missed  : {'yes — final rung logs not-done' if ladder.log_missed_at_final_rung else 'no'}")
    print(f"  family alert: {ladder.family_alert_recipient or 'none (default)'}")
    if not client.configured:
        return 0
    try:
        regimen = schedule.fetch_regimen(client, client.patient_id)
    except MedplumError as exc:
        print(f"  medplum     : UNREACHABLE — {exc}")
        return 1
    tz = datetime.now().astimezone().tzinfo
    slots = schedule.build_day_slots(
        regimen.requests,
        regimen.cartridges,
        regimen.medication_displays,
        date.today(),
        tz,
        dispenser_id=(regimen.dispenser or {}).get("id"),
    )
    print(f"  medplum     : connected — {len(regimen.requests)} active med(s), {len(regimen.cartridges)} cartridge(s)")
    for slot in slots:
        tray = f"tray {slot.tray}" if slot.tray else "no tray assigned"
        print(f"    {slot.time[:5]}  {slot.medication_display}  ({tray})")
    return 0


def cmd_run(args) -> int:
    """Real-hardware loop, one day at a time, forever (systemd restarts it
    on failure). Requires credentials, a patient id, and a pill-dispenser
    Device in Medplum (README "Pi setup"). Re-fetches the regimen every
    morning so med/cartridge changes in the app apply the next day without
    a restart."""
    client = DispenserMedplumClient()
    if not client.configured or not client.patient_id:
        print("run: DISPENSER_MEDPLUM_* env not configured — see pi-dispenser/README.md", file=sys.stderr)
        return 1
    clock = RealClock()
    backend = GpioBackend()
    sink = MedplumSink(client)
    while True:
        today = clock.now().date()
        regimen = schedule.fetch_regimen(client, client.patient_id)
        dispenser_id = (regimen.dispenser or {}).get("id")
        if not dispenser_id:
            print("run: no pill-dispenser Device found in Medplum — create one first (README)", file=sys.stderr)
            return 1
        slots = schedule.build_day_slots(
            regimen.requests,
            regimen.cartridges,
            regimen.medication_displays,
            today,
            clock.now().tzinfo,
            dispenser_id=dispenser_id,
        )
        agent = DispenserAgent(
            backend=backend,
            clock=clock,
            sink=sink,
            patient_id=client.patient_id,
            dispenser_id=dispenser_id,
            ladder_config=_ladder(args),
            webhook_url=args.webhook,
        )
        # Only future slots: a mid-day (re)start must not spray out every
        # already-passed dose of the day. Past unlogged doses stay unlogged —
        # the schedule shows the gap; the machine never backfills (§3).
        agent.run_day([s for s in slots if s.scheduled > clock.now()])
        clock.sleep_until(datetime.combine(today, dtime(23, 59, 59), clock.now().tzinfo))
        clock.sleep_until(clock.now())  # roll into the next day


def main(argv: list[str] | None = None) -> int:
    """argparse entrypoint; returns the subcommand's exit code."""
    parser = argparse.ArgumentParser(
        prog="pi_dispenser",
        description="HealMeDaily pill-dispenser agent. Not a certified medical device. "
        "The dispenser never decides whether a medication may be taken.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_sim = sub.add_parser("sim", help="run a simulated day from a JSON scenario")
    p_sim.add_argument("--scenario", required=True, help="scenario JSON (see scenarios/day.json)")
    p_sim.add_argument(
        "--speed",
        type=float,
        default=60.0,
        help="sim seconds per real second; hops are capped at 1s real, 0 = as fast as possible (default 60)",
    )
    p_sim.add_argument("--ladder", help="escalation ladder config JSON (default: the design ladder)")
    p_sim.add_argument("--webhook", help="LAN webhook URL POSTed on every state change")
    p_sim.add_argument("--dry-run", action="store_true", help="never write to Medplum; print FHIR payloads")
    p_sim.add_argument("--quiet-payloads", action="store_true", help="dry-run: one line per event, no JSON bodies")
    p_sim.set_defaults(func=cmd_sim)

    p_status = sub.add_parser("status", help="show configuration and Medplum connectivity")
    p_status.add_argument("--ladder", help="escalation ladder config JSON")
    p_status.set_defaults(func=cmd_status)

    p_run = sub.add_parser("run", help="real hardware loop (Raspberry Pi)")
    p_run.add_argument("--ladder", help="escalation ladder config JSON")
    p_run.add_argument("--webhook", help="LAN webhook URL POSTed on every state change")
    p_run.set_defaults(func=cmd_run)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
