"""Dispenser agent: the confirmation-first main loop.

At slot time: rotate spindle -> open the day's wedge -> pills drop ->
MedicationDispense. Then watch for pickup (load cell first, camera fallback,
self-report last) -> MedicationAdministration with the verification
extension. Between drop and pickup the user-configured escalation ladder
runs; every state change fires a LAN webhook (fire-and-forget).

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

CAMERA_POLL_MINUTES = 5  # fallback pickup detection cadence when the load cell is out


def choose_verification(weight_confirmed: bool, camera_confirmed: bool) -> str:
    """Verification hierarchy (FHIR-MAPPING.md §9): weight > camera > self."""
    if weight_confirmed:
        return "weight"
    if camera_confirmed:
        return "camera"
    return "self"


def default_webhook_poster(url: str, payload: dict) -> None:
    httpx.post(url, json=payload, timeout=2.0)


class DispenserAgent:
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
        self._awaiting: dict[str, tuple[DoseSlot, DoseLadder]] = {}

        if getattr(backend.load_cell, "available", True):
            backend.load_cell.on_change(self._on_weight_change)
        tap_hook = getattr(backend, "on_user_tap", None)
        if tap_hook:
            tap_hook(self._on_user_tap)

    # -- main loop -----------------------------------------------------------

    def run_day(self, slots: list[DoseSlot]) -> None:
        queue = sorted(slots, key=lambda s: (s.scheduled, s.ident_value))
        self._say(f"{len(queue)} dose slot(s) scheduled today")
        while True:
            now = self._clock.now()
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
        if not self._backend.lid.is_closed():
            self._say("warning: lid is open — dispensing anyway (the machine never gates a dose)")
        self._backend.spindle.rotate_to_tray(slot.tray or 1)
        self._backend.spindle.open_wedge(slot.scheduled.weekday())
        self._say(f"dispensed {slot.medication_display} (tray {slot.tray or '?'}) — {slot.ident_value}")
        self._sink.submit(dispense_event(slot, self._patient_id, self._dispenser_id, when_handed_over=now))
        self._awaiting[slot.ident_value] = (slot, DoseLadder(config=self._config, started=slot.scheduled))
        self._notify("dispensed", slot, at=now)

    # -- escalation ----------------------------------------------------------

    def _fire_due_rungs(self, now: datetime) -> None:
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

    def _on_weight_change(self, grams: float, at: datetime) -> None:
        if self._awaiting and grams <= PICKUP_EMPTY_GRAMS:
            self._complete_pickups(at, choose_verification(weight_confirmed=True, camera_confirmed=False))

    def _on_user_tap(self, at: datetime) -> None:
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
        return not getattr(self._backend.load_cell, "available", True) and getattr(
            self._backend.camera, "available", False
        )

    def _camera_sees_empty(self) -> bool:
        camera = self._backend.camera
        if not getattr(camera, "available", False):
            return False
        frame = camera.capture()
        return bool(frame) and self._frame_shows_empty(frame)

    def _camera_fallback_check(self, now: datetime) -> None:
        if self._awaiting and self._camera_fallback_active() and self._camera_sees_empty():
            self._complete_pickups(now, choose_verification(weight_confirmed=False, camera_confirmed=True))

    def _complete_pickups(self, at: datetime, verification: str) -> None:
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
