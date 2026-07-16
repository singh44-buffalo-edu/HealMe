"""Hardware abstraction layer (HAL) for the pill dispenser.

Physical model (design ref: "Web - Dispenser Suite"): a lidded cylinder with
8 colour-rimmed trays stacked on a central spindle, each tray split into
7 pie wedges (one dose per wedge — one wedge per weekday). At dose time the
spindle rotates the tray into position, the day's wedge opens, and the pills
fall through the cone funnel into the base tray, which sits on a load cell.

Two backends:

- ``SimulatedBackend`` — deterministic and scriptable via a JSON scenario
  plus an injected ``SimClock``. Runs anywhere, zero hardware.
- ``GpioBackend`` — real hardware on a Raspberry Pi. RPi.GPIO / gpiozero /
  hx711 are imported lazily *inside* methods so this module imports cleanly
  off-Pi; touching hardware off-Pi raises a clear error.

Safety: the HAL moves plastic and reads sensors. It never contains dosing
logic — whether a medication may be taken is never decided here.
"""

from __future__ import annotations

import time as _time
from collections.abc import Callable
from datetime import date, datetime, time as dtime, timedelta

# ---------------------------------------------------------------------------
# Clocks — time is always injected so the ladder/agent are fully testable.
# ---------------------------------------------------------------------------


class SimClock:
    """Virtual clock for the simulator.

    ``sleep_until`` jumps between events instead of ticking, firing any
    scenario events (pickups, taps) that fall inside the jump at their exact
    scheduled sim time. Pacing: each hop real-sleeps
    ``min(sim_delta / speed, max_real_pause)`` seconds; ``speed <= 0``
    disables real sleeping entirely (as fast as possible).
    """

    def __init__(self, start: datetime, speed: float = 60.0, max_real_pause: float = 1.0) -> None:
        if start.tzinfo is None:
            raise ValueError("SimClock start must be timezone-aware")
        self._now = start
        self.speed = speed
        self.max_real_pause = max_real_pause
        self._sources: list[object] = []  # objects with next_event_at() / fire_due(now)

    def now(self) -> datetime:
        return self._now

    def subscribe(self, source: object) -> None:
        self._sources.append(source)

    def _pace(self, delta: timedelta) -> None:
        if self.speed > 0 and delta.total_seconds() > 0:
            _time.sleep(min(delta.total_seconds() / self.speed, self.max_real_pause))

    def sleep_until(self, target: datetime) -> None:
        target = max(target, self._now)
        while True:
            upcoming = [t for t in (s.next_event_at() for s in self._sources) if t is not None]  # type: ignore[attr-defined]
            nxt = min(upcoming, default=None)
            if nxt is None or nxt > target:
                break
            if nxt > self._now:
                self._pace(nxt - self._now)
                self._now = nxt
            for source in self._sources:
                source.fire_due(self._now)  # type: ignore[attr-defined]
        if target > self._now:
            self._pace(target - self._now)
            self._now = target


class RealClock:
    """Wall clock for the Pi. Sensor callbacks arrive from device threads."""

    def __init__(self, tz=None) -> None:
        self._tz = tz or datetime.now().astimezone().tzinfo

    def now(self) -> datetime:
        return datetime.now(self._tz)

    def sleep_until(self, target: datetime) -> None:
        while True:
            remaining = (target - self.now()).total_seconds()
            if remaining <= 0:
                return
            _time.sleep(min(remaining, 30.0))


# ---------------------------------------------------------------------------
# Device interfaces (duck-typed; both backends implement the same surface)
# ---------------------------------------------------------------------------
#
#   SpindleMotor: rotate_to_tray(tray: int), open_wedge(wedge: int)
#   LoadCell:     available: bool, read_grams() -> float,
#                 on_change(cb: (grams: float, at: datetime) -> None)
#   ChimeRing:    ring(pattern: str = "gentle")
#   BayCamera:    available: bool, capture() -> bytes | None
#   LidSensor:    is_closed() -> bool
#
# A Backend bundles the five devices plus retract_base_tray() (the T+2h
# final-rung actuator from the Dose Ritual design).

TRAY_COUNT = 8
WEDGES_PER_TRAY = 7
PICKUP_EMPTY_GRAMS = 0.05  # readings at/below this mean "base tray is empty"


def simulated_frame_shows_empty(frame: bytes) -> bool:
    """Classifier for SimulatedBackend camera frames. On real hardware this
    is the on-Pi pill-vision model (out of scope here)."""
    return frame.endswith(b"empty-tray")


# ---------------------------------------------------------------------------
# Simulated backend
# ---------------------------------------------------------------------------


class _SimSpindle:
    def __init__(self, backend: "SimulatedBackend") -> None:
        self._b = backend

    def rotate_to_tray(self, tray: int) -> None:
        self._b._log(f"spindle: rotate to tray {tray}")
        self._b.current_tray = tray

    def open_wedge(self, wedge: int) -> None:
        self._b._log(f"spindle: open wedge {wedge} -> pills drop via funnel to base tray")
        self._b._drop_pills()


class _SimLoadCell:
    def __init__(self, backend: "SimulatedBackend") -> None:
        self._b = backend

    @property
    def available(self) -> bool:
        return self._b.load_cell_available

    def read_grams(self) -> float:
        if not self.available:
            raise RuntimeError("simulated load cell is disabled in this scenario")
        return self._b.tray_grams

    def on_change(self, callback: Callable[[float, datetime], None]) -> None:
        self._b._weight_callbacks.append(callback)


class _SimChime:
    def __init__(self, backend: "SimulatedBackend") -> None:
        self._b = backend

    def ring(self, pattern: str = "gentle") -> None:
        self._b._log(f"chime: ring ({pattern})")


class _SimCamera:
    def __init__(self, backend: "SimulatedBackend") -> None:
        self._b = backend

    @property
    def available(self) -> bool:
        return self._b.camera_available

    def capture(self) -> bytes | None:
        if not self.available:
            return None
        state = b"pills-present" if self._b.tray_has_pills else b"empty-tray"
        return b"SIMFRAME " + state


class _SimLid:
    def __init__(self, backend: "SimulatedBackend") -> None:
        self._b = backend

    def is_closed(self) -> bool:
        return self._b.lid_closed


class SimulatedBackend:
    """Deterministic backend scripted by a scenario dict.

    Scenario keys used here:
      hardware.load_cell (bool, default true)   — load cell present
      hardware.camera (bool, default true)      — bay camera present
      hardware.wedge_grams (float, default 0.62)— weight one wedge adds
      hardware.lid_closed (bool, default true)
      pickups: [{"at": "HH:MM:SS", "via": "sensor"|"tap"}]
        "sensor": the tray physically empties; whichever sensors exist notice.
        "tap": the user taps "Taken" in the app (self-report path).
    """

    def __init__(self, scenario: dict, clock: SimClock, day: date, out: Callable[[str], None] = print) -> None:
        hw = scenario.get("hardware", {})
        self.load_cell_available: bool = bool(hw.get("load_cell", True))
        self.camera_available: bool = bool(hw.get("camera", True))
        self.wedge_grams: float = float(hw.get("wedge_grams", 0.62))
        self.lid_closed: bool = bool(hw.get("lid_closed", True))

        self._clock = clock
        self._out = out
        self.log: list[str] = []
        self.tray_grams = 0.0
        self.tray_has_pills = False
        self.current_tray = 1
        self.base_tray_retracted = False
        self._weight_callbacks: list[Callable[[float, datetime], None]] = []
        self._tap_callbacks: list[Callable[[datetime], None]] = []

        tz = clock.now().tzinfo
        self._pickups: list[tuple[datetime, str]] = sorted(
            (
                datetime.combine(day, dtime.fromisoformat(p["at"]), tz),
                p.get("via", "sensor"),
            )
            for p in scenario.get("pickups", [])
        )
        self._next_pickup = 0
        clock.subscribe(self)

        self.spindle = _SimSpindle(self)
        self.load_cell = _SimLoadCell(self)
        self.chime = _SimChime(self)
        self.camera = _SimCamera(self)
        self.lid = _SimLid(self)

    # -- backend surface ----------------------------------------------------

    def retract_base_tray(self) -> None:
        self.base_tray_retracted = True
        self._log("base tray: retracted (final escalation rung)")

    def on_user_tap(self, callback: Callable[[datetime], None]) -> None:
        self._tap_callbacks.append(callback)

    # -- scenario event source (SimClock protocol) --------------------------

    def next_event_at(self) -> datetime | None:
        if self._next_pickup < len(self._pickups):
            return self._pickups[self._next_pickup][0]
        return None

    def fire_due(self, now: datetime) -> None:
        while self._next_pickup < len(self._pickups) and self._pickups[self._next_pickup][0] <= now:
            at, via = self._pickups[self._next_pickup]
            self._next_pickup += 1
            self._pickup(at, via)

    # -- internals ----------------------------------------------------------

    def _log(self, msg: str) -> None:
        self.log.append(msg)
        self._out(f"[hw {self._clock.now().strftime('%H:%M:%S')}] {msg}")

    def _drop_pills(self) -> None:
        self.tray_grams += self.wedge_grams
        self.tray_has_pills = True
        if self.load_cell_available:
            for cb in self._weight_callbacks:
                cb(self.tray_grams, self._clock.now())

    def _pickup(self, at: datetime, via: str) -> None:
        self.tray_grams = 0.0
        self.tray_has_pills = False
        self._log(f"scenario: pickup ({via})")
        if via == "tap":
            for cb in self._tap_callbacks:
                cb(at)
        elif self.load_cell_available:
            for cb in self._weight_callbacks:
                cb(0.0, at)
        # else: no sensor fires — the agent's camera fallback (or nothing)
        # discovers the empty tray at its next wake point.


# ---------------------------------------------------------------------------
# GPIO backend (Raspberry Pi)
# ---------------------------------------------------------------------------
#
# GPIO pin map (BCM numbering) — adjust to your wiring, then update here:
#
#   SPINDLE_STEP = 17   stepper STEP  (A4988/DRV8825 driver)
#   SPINDLE_DIR  = 27   stepper DIR
#   SPINDLE_EN   = 22   stepper ENABLE (active low)
#   WEDGE_SERVO  = 18   wedge-release servo (hardware PWM pin)
#   TRAY_SERVO   = 12   base-tray retract servo (hardware PWM pin)
#   HX711_DOUT   = 5    load-cell ADC data
#   HX711_SCK    = 6    load-cell ADC clock
#   CHIME_PIN    = 13   piezo buzzer
#   LID_SWITCH   = 26   lid reed switch (internal pull-up, closed = low)
#   CAMERA            = CSI ribbon (picamera2), not a GPIO pin
#
# CALIBRATION CONSTANTS — placeholders, NOT verified facts. Every rig
# differs; measure on your hardware (see README "Calibration") before use:

WEDGE_SERVO_MIN_PULSE_MS = 1.0  # CALIBRATE: closed position — find by slow sweep
WEDGE_SERVO_MAX_PULSE_MS = 2.0  # CALIBRATE: open position — find by slow sweep
TRAY_SERVO_MIN_PULSE_MS = 1.0  # CALIBRATE: extended
TRAY_SERVO_MAX_PULSE_MS = 2.0  # CALIBRATE: retracted
STEPS_PER_TRAY = 25  # CALIBRATE: (steps/rev x microstepping x gear ratio) / TRAY_COUNT
LOADCELL_SCALE = 1.0  # CALIBRATE: raw_units / gram, from a known mass
LOADCELL_OFFSET = 0  # CALIBRATE: raw reading with empty base tray
LOADCELL_POLL_SECONDS = 0.5

_OFF_PI_HINT = (
    "GpioBackend needs Raspberry Pi hardware libraries ({dep}). "
    "Off-Pi, run the simulator instead: python -m pi_dispenser sim --scenario scenarios/day.json"
)


def _require(module: str):
    try:
        return __import__(module)
    except ImportError as exc:  # pragma: no cover - only reachable off-Pi
        raise RuntimeError(_OFF_PI_HINT.format(dep=module)) from exc


class _GpioSpindle:
    def rotate_to_tray(self, tray: int) -> None:
        _require("gpiozero")
        raise NotImplementedError(
            "Stepper bring-up pending: drive STEPS_PER_TRAY steps per tray position "
            "via SPINDLE_STEP/SPINDLE_DIR after calibrating STEPS_PER_TRAY (README)."
        )

    def open_wedge(self, wedge: int) -> None:
        _require("gpiozero")
        raise NotImplementedError(
            "Servo bring-up pending: sweep WEDGE_SERVO between the calibrated "
            "MIN/MAX pulse widths (they are placeholders until measured)."
        )


class _GpioLoadCell:
    def __init__(self) -> None:
        self._callbacks: list[Callable[[float, datetime], None]] = []
        self._thread_started = False

    @property
    def available(self) -> bool:
        try:
            __import__("hx711")
            return True
        except ImportError:
            return False

    def read_grams(self) -> float:
        _require("hx711")
        raise NotImplementedError("HX711 bring-up pending: (raw - LOADCELL_OFFSET) / LOADCELL_SCALE after calibration.")

    def on_change(self, callback: Callable[[float, datetime], None]) -> None:
        self._callbacks.append(callback)
        if not self._thread_started:
            _require("hx711")  # fail fast off-Pi; a poll thread is started on real hardware
            self._thread_started = True


class _GpioChime:
    def ring(self, pattern: str = "gentle") -> None:
        gpiozero = _require("gpiozero")
        buzzer = gpiozero.Buzzer(13)
        beeps = 1 if pattern == "gentle" else 2
        for _ in range(beeps):
            buzzer.on()
            _time.sleep(0.15)
            buzzer.off()
            _time.sleep(0.1)
        buzzer.close()


class _GpioCamera:
    @property
    def available(self) -> bool:
        try:
            __import__("picamera2")
            return True
        except ImportError:
            return False

    def capture(self) -> bytes | None:
        if not self.available:
            return None
        _require("picamera2")
        raise NotImplementedError("picamera2 still-capture bring-up pending (README).")


class _GpioLid:
    def is_closed(self) -> bool:
        gpiozero = _require("gpiozero")
        switch = gpiozero.Button(26, pull_up=True)
        closed = bool(switch.is_pressed)
        switch.close()
        return closed


class GpioBackend:
    """Real-hardware backend. Constructing it off-Pi is fine (imports are
    lazy); the first method that touches hardware raises a clear error."""

    def __init__(self) -> None:
        self.spindle = _GpioSpindle()
        self.load_cell = _GpioLoadCell()
        self.chime = _GpioChime()
        self.camera = _GpioCamera()
        self.lid = _GpioLid()

    def retract_base_tray(self) -> None:
        _require("gpiozero")
        raise NotImplementedError(
            "Base-tray servo bring-up pending: TRAY_SERVO pulse widths are calibration placeholders."
        )
