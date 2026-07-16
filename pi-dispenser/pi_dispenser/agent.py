"""Dispenser agent: the confirmation-first main loop.

At slot time: rotate spindle -> open the day's wedge -> pills drop ->
MedicationDispense. Then watch for pickup (load cell first, camera fallback,
self-report last) -> MedicationAdministration with the verification
extension. Between drop and pickup the user-configured escalation ladder
runs; every state change fires a LAN webhook (fire-and-forget).

Wiring (see cli.py): backend = hal.SimulatedBackend|GpioBackend, clock =
hal.SimClock|RealClock, sink = events.DryRunSink|MedplumSink. The agent is
the only module that combines schedule + hal + ladder + events.

MAIN LOOP STATES — a dose slot moves through exactly these:

    queued            in `queue`, scheduled time not reached yet
    awaiting-pickup   dispensed; in `_awaiting` with a live DoseLadder
                      (ladder state WAITING); rungs fire as they come due
    picked-up         sensor/tap confirmed -> pickup_event written,
                      removed from `_awaiting` (ladder PICKED_UP)
    closed            final close-tray rung fired -> tray retracted,
                      removed from `_awaiting` (ladder CLOSED); missed log
                      written ONLY if the owner's config says so

run_day exits when both `queue` and `_awaiting` are empty. Each wake-up
does, in order: dispense due slots -> camera fallback poll -> fire due
ladder rungs -> compute the next wake (next slot, next rung, camera poll,
or a 1h keep-alive).

Safety invariants, enforced here:
  - the dispenser writes dose events ONLY;
  - nothing here gates whether a medication may be taken — no inventory
    check, no timer, no sensor ever withholds a dose or blocks a manual log;
  - a missed pickup creates NO resource until the user-configured ladder's
    final rung fires and its config says to log.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta

import httpx

from .events import dispense_event, escalation_event, missed_event, pickup_event
from .hal import PICKUP_EMPTY_GRAMS, simulated_frame_shows_empty
from .ladder import RUNG_NOTES, DoseLadder, LadderConfig
from .schedule import DoseSlot

# Fallback pickup-detection cadence when the load cell is out: the camera
# has no change events, so we poll. 5 min keeps detection well inside the
# T+15 rung gap without hammering the camera.
CAMERA_POLL_MINUTES = 5


def choose_verification(weight_confirmed: bool, camera_confirmed: bool) -> str:
    """Verification hierarchy (FHIR-MAPPING.md §9): weight > camera > self.

    Maps what the sensors saw to the administration-verification valueCode:
    the strongest available evidence wins, and "self" is the floor — a
    pickup with no sensor corroboration is still logged, just labeled as
    self-reported (evidence strength is data; it never blocks a log)."""
    if weight_confirmed:
        return "weight"
    if camera_confirmed:
        return "camera"
    return "self"


def default_webhook_poster(url: str, payload: dict) -> None:
    """POST a status event to the LAN webhook. 2s timeout: the caller treats
    any failure as ignorable, so slow LAN must not stall the dose loop."""
    httpx.post(url, json=payload, timeout=2.0)


class DispenserAgent:
    """One day's dispense/observe/escalate loop over a HAL backend.

    Everything is injected (backend, clock, sink, ladder config, webhook
    poster, frame classifier, output fn) so tests can run a full day with
    zero hardware, zero network and zero real sleeping. `patient_id` /
    `dispenser_id` are the FHIR ids stamped into every event payload.

    Registers for load-cell change events and (sim only) app-tap events at
    construction; `run_day` then drives everything off the injected clock.
    """

    def __init__(
        self,
        backend,
        clock,
        sink,
        patient_id: str,
        dispenser_id: str,
        ladder_config: LadderConfig | None = None,
        webhook_url: str | None = None,
        webhook_poster: Callable[[str, dict], None] = default_webhook_poster,
        frame_shows_empty: Callable[[bytes], bool] = simulated_frame_shows_empty,
        out: Callable[[str], None] = print,
    ) -> None:
        self._backend = backend
        self._clock = clock
        self._sink = sink
        self._patient_id = patient_id
        self._dispenser_id = dispenser_id
        self._config = ladder_config or LadderConfig.default()
        self._webhook_url = webhook_url
        self._webhook_poster = webhook_poster
        self._frame_shows_empty = frame_shows_empty
        self._out = out
        # ident_value -> (slot, its ladder): every dose dropped but not yet
        # picked up / closed. THE core piece of loop state.
        self._awaiting: dict[str, tuple[DoseSlot, DoseLadder]] = {}

        if getattr(backend.load_cell, "available", True):
            backend.load_cell.on_change(self._on_weight_change)
        tap_hook = getattr(backend, "on_user_tap", None)
        if tap_hook:
            tap_hook(self._on_user_tap)

    # -- main loop -----------------------------------------------------------

    def run_day(self, slots: list[DoseSlot]) -> None:
        """Run the loop until every slot is dispensed AND resolved (picked
        up or closed). Sensor callbacks may fire inside sleep_until (the
        SimClock delivers scenario events there; GPIO threads at any time),
        so `_awaiting` can shrink while we sleep — every iteration re-reads
        the clock and re-derives what is due."""
        queue = sorted(slots, key=lambda s: (s.scheduled, s.ident_value))
        self._say(f"{len(queue)} dose slot(s) scheduled today")
        while True:
            now = self._clock.now()
            # Dispense everything due (several slots can share one time).
            while queue and queue[0].scheduled <= now:
                self._dispense(queue.pop(0), now)
            self._camera_fallback_check(now)
            self._fire_due_rungs(now)
            if not queue and not self._awaiting:
                break
            wake = self._next_wake(now, queue)
            self._clock.sleep_until(wake)
        self._say("day complete — all dose slots resolved")

    def _next_wake(self, now: datetime, queue: list[DoseSlot]) -> datetime:
        # Earliest of: next scheduled slot, next unfired ladder rung, the
        # camera poll (only while it is the active detection path), or a 1h
        # keep-alive so a rung-less custom ladder still re-checks sensors.
        wakes = [queue[0].scheduled] if queue else []
        for _slot, ladder in self._awaiting.values():
            rung_wake = ladder.next_wake()
            if rung_wake:
                wakes.append(rung_wake)
        if self._awaiting and self._camera_fallback_active():
            wakes.append(now + timedelta(minutes=CAMERA_POLL_MINUTES))
        if not wakes:
            # awaiting pickup with no rungs left (custom ladder without
            # close-tray): keep listening for sensor/tap events.
            wakes.append(now + timedelta(hours=1))
        return min(wakes)

    # -- drop ---------------------------------------------------------------

    def _dispense(self, slot: DoseSlot, now: datetime) -> None:
        """queued -> awaiting-pickup: physically drop the dose, write the
        MedicationDispense, start the slot's escalation ladder."""
        if not self._backend.lid.is_closed():
            self._say("warning: lid is open — dispensing anyway (the machine never gates a dose)")
        # Wedge index = weekday (Mon=0..Sun=6): each tray holds one week of
        # one med. Tray defaults to 1 when no cartridge is mapped — the dose
        # is still offered (unmapped hardware never withholds a med).
        self._backend.spindle.rotate_to_tray(slot.tray or 1)
        self._backend.spindle.open_wedge(slot.scheduled.weekday())
        self._say(f"dispensed {slot.medication_display} (tray {slot.tray or '?'}) — {slot.ident_value}")
        self._sink.submit(dispense_event(slot, self._patient_id, self._dispenser_id, when_handed_over=now))
        # Ladder anchors to the SCHEDULED time, not `now`: a delayed drop
        # (agent restart) must not silently shift every rung later.
        self._awaiting[slot.ident_value] = (slot, DoseLadder(config=self._config, started=slot.scheduled))
        self._notify("dispensed", slot, at=now)

    # -- escalation ----------------------------------------------------------

    def _fire_due_rungs(self, now: datetime) -> None:
        """Walk every awaiting dose's ladder and fire what is due. Each rung
        (except close-tray) chimes/notifies AND writes a CommunicationRequest
        whose identifier includes the rung medium — re-fires are idempotent
        at the sink."""
        # Copy keys: _close_tray mutates _awaiting during iteration.
        for key in list(self._awaiting):
            slot, ladder = self._awaiting.get(key, (None, None))
            if slot is None:
                continue
            for index, rung in ladder.due_rungs(now):
                ladder.mark_fired(index)
                if rung.action == "close-tray":
                    self._close_tray(slot, ladder, now)
                    break
                if rung.action == "chime":
                    self._backend.chime.ring("gentle")
                elif rung.action == "ask-why":
                    self._backend.chime.ring("ask")
                self._sink.submit(
                    escalation_event(
                        slot,
                        self._patient_id,
                        self._dispenser_id,
                        medium=rung.action,
                        at=now,
                        note=RUNG_NOTES.get(rung.action, ""),
                    )
                )
                self._say(f"escalation rung T+{rung.offset_minutes}m ({rung.action}) — {slot.ident_value}")
                self._notify("escalation", slot, at=now, rung=rung.action)

    def _close_tray(self, slot: DoseSlot, ladder: DoseLadder, now: datetime) -> None:
        """awaiting-pickup -> closed: the final rung. Retract the tray, then
        apply the two owner-configured choices — family alert (opt-in only)
        and the missed-dose log (§9: the ONLY path that ever writes not-done
        for a dispensed dose, and only because the owner's config says so)."""
        self._backend.retract_base_tray()
        ladder.close(now)
        self._awaiting.pop(slot.ident_value, None)
        if self._config.family_alert_recipient:
            # Opt-in ONLY: absent from every default ladder ("Never — alerts stay yours").
            self._sink.submit(
                escalation_event(
                    slot,
                    self._patient_id,
                    self._dispenser_id,
                    medium="push",
                    at=now,
                    note="Configured family alert: a dose was not picked up",
                    recipient=self._config.family_alert_recipient,
                )
            )
        if self._config.log_missed_at_final_rung:
            self._sink.submit(missed_event(slot, self._patient_id, self._dispenser_id, at=now))
            self._say(f"final rung: tray closed, logged not-done/user-marked-missed per your config — {slot.ident_value}")
        else:
            self._say(
                f"final rung: tray closed — per your config NO missed-dose resource is written; "
                f"the dose stays unlogged on the schedule — {slot.ident_value}"
            )
        self._notify("tray-closed", slot, at=now, logged_missed=self._config.log_missed_at_final_rung)

    # -- pickup detection ----------------------------------------------------
    #
    # Three detection paths, mirroring the §9 verification hierarchy:
    #   1. load-cell change event -> "weight" (strongest, event-driven)
    #   2. camera poll, ONLY while the load cell is unavailable -> "camera"
    #   3. app tap relayed to the agent -> re-check sensors, floor is "self"

    def _on_weight_change(self, grams: float, at: datetime) -> None:
        """Load-cell callback: tray weight at/below the empty threshold while
        doses await means the user lifted them out — weight-verified."""
        if self._awaiting and grams <= PICKUP_EMPTY_GRAMS:
            self._complete_pickups(at, choose_verification(weight_confirmed=True, camera_confirmed=False))

    def _on_user_tap(self, at: datetime) -> None:
        """User tapped "Taken" in the app. The tap is the claim; the sensors
        are the evidence — re-read whatever exists right now and label the
        log with the strongest confirmation (a broken load cell downgrades
        gracefully instead of erroring)."""
        if not self._awaiting:
            return
        weight_ok = False
        load_cell = self._backend.load_cell
        if getattr(load_cell, "available", False):
            try:
                weight_ok = load_cell.read_grams() <= PICKUP_EMPTY_GRAMS
            except Exception:
                weight_ok = False
        camera_ok = self._camera_sees_empty()
        self._complete_pickups(at, choose_verification(weight_ok, camera_ok))

    def _camera_fallback_active(self) -> bool:
        """Camera polling runs ONLY as a fallback — with a live load cell the
        camera stays off (weight evidence is stronger and event-driven)."""
        return not getattr(self._backend.load_cell, "available", True) and getattr(
            self._backend.camera, "available", False
        )

    def _camera_sees_empty(self) -> bool:
        """One frame -> does the base tray look empty? The classifier is
        injected (sim marker bytes now; on-Pi pill-vision model later)."""
        camera = self._backend.camera
        if not getattr(camera, "available", False):
            return False
        frame = camera.capture()
        return bool(frame) and self._frame_shows_empty(frame)

    def _camera_fallback_check(self, now: datetime) -> None:
        if self._awaiting and self._camera_fallback_active() and self._camera_sees_empty():
            self._complete_pickups(now, choose_verification(weight_confirmed=False, camera_confirmed=True))

    def _complete_pickups(self, at: datetime, verification: str) -> None:
        """awaiting-pickup -> picked-up for EVERY awaiting dose: the base
        tray is one physical bowl, so "it is empty" can only mean all doses
        in it were taken — per-dose attribution is impossible by design."""
        for slot, ladder in list(self._awaiting.values()):
            ladder.pickup(at)
            self._sink.submit(pickup_event(slot, self._patient_id, self._dispenser_id, at, verification))
            self._say(f"pickup confirmed ({verification}-verified) — {slot.ident_value}")
            self._notify("picked-up", slot, at=at, verification=verification)
        self._awaiting.clear()

    # -- plumbing -------------------------------------------------------------

    def _say(self, msg: str) -> None:
        self._out(f"[agent {self._clock.now().strftime('%H:%M:%S')}] {msg}")

    def _notify(self, event: str, slot: DoseSlot, at: datetime, **detail) -> None:
        """LAN webhook on every state change — fire and forget, never fatal."""
        if not self._webhook_url:
            return
        payload = {
            "event": event,
            "dose": slot.ident_value,
            "medication": slot.medication_display,
            "at": at.isoformat(),
            **detail,
        }
        try:
            self._webhook_poster(self._webhook_url, payload)
        except Exception as exc:  # noqa: BLE001 - webhook must never break dosing flow
            self._say(f"webhook failed (ignored): {exc}")
