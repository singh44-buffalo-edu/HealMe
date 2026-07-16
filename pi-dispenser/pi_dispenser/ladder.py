"""User-configured escalation ladder (design ref: "Web - Dose Ritual").

Default ladder — exactly the design's, and always the user's to change:

    T+0     chime       dispenser only, gentle
    T+15    push        re-chime + push to phone/watch
    T+45    ask-why     "Skip tonight? Tell me why" — a reason is data too
    T+2h    close-tray  base tray retracts; logs not-done/user-marked-missed
                        ONLY if the config says so
    Never   family alert — NO family alert unless explicitly configured

Rules (FHIR-MAPPING.md §3 + §9): no missed-dose resource exists until the
user-configured ladder's FINAL rung fires AND log_missed_at_final_rung is
true. Escalation never gates the pills — the tray is open the whole time and
inventory/timers never decide whether a medication may be taken.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

ACTIONS = ("chime", "push", "ask-why", "close-tray")

# chime/push/ask-why produce a CommunicationRequest (FHIR-MAPPING.md §9 medium codes)
RUNG_NOTES = {
    "chime": "Dose is in the tray",
    "push": "Dose still in the tray — re-chime + push",
    "ask-why": "Skip this one? Tell me why — a reason is data too",
}


@dataclass(frozen=True)
class Rung:
    offset_minutes: int
    action: str

    def __post_init__(self) -> None:
        if self.action not in ACTIONS:
            raise ValueError(f"unknown ladder action {self.action!r}; expected one of {ACTIONS}")
        if self.offset_minutes < 0:
            raise ValueError("rung offset_minutes must be >= 0")


DEFAULT_RUNGS: tuple[Rung, ...] = (
    Rung(0, "chime"),
    Rung(15, "push"),
    Rung(45, "ask-why"),
    Rung(120, "close-tray"),
)


@dataclass(frozen=True)
class LadderConfig:
    rungs: tuple[Rung, ...] = DEFAULT_RUNGS
    #: The design default logs a missed dose at T+2h ("tray retracts · logged
    #: missed") — but it is the USER's ladder: false means the tray closes
    #: silently and the schedule simply shows the dose as unlogged.
    log_missed_at_final_rung: bool = True
    #: No family alert by default, ever ("Never — your rules: alerts stay
    #: yours"). Set a Reference (e.g. "RelatedPerson/xyz") to opt in; the
    #: alert then goes out at the final rung.
    family_alert_recipient: str | None = None

    def __post_init__(self) -> None:
        offsets = [r.offset_minutes for r in self.rungs]
        if not self.rungs:
            raise ValueError("ladder needs at least one rung")
        if offsets != sorted(offsets) or len(set(offsets)) != len(offsets):
            raise ValueError("rung offsets must be strictly increasing")
        closers = [r for r in self.rungs if r.action == "close-tray"]
        if len(closers) > 1 or (closers and self.rungs[-1].action != "close-tray"):
            raise ValueError("close-tray may appear once, and only as the final rung")

    @staticmethod
    def default() -> "LadderConfig":
        return LadderConfig()

    @staticmethod
    def from_dict(data: dict) -> "LadderConfig":
        rungs = tuple(
            Rung(offset_minutes=int(r["offset_minutes"]), action=r["action"]) for r in data.get("rungs", [])
        ) or DEFAULT_RUNGS
        return LadderConfig(
            rungs=rungs,
            log_missed_at_final_rung=bool(data.get("log_missed_at_final_rung", True)),
            family_alert_recipient=data.get("family_alert_recipient") or None,
        )

    @staticmethod
    def from_file(path: str | Path) -> "LadderConfig":
        return LadderConfig.from_dict(json.loads(Path(path).read_text()))


# ---------------------------------------------------------------------------
# Per-dose state machine (time injected — no wall clock in here)
# ---------------------------------------------------------------------------

WAITING = "waiting"
PICKED_UP = "picked-up"
CLOSED = "closed"


@dataclass
class DoseLadder:
    """Tracks one dispensed dose from drop to pickup/close."""

    config: LadderConfig
    started: datetime  # T0 = the scheduled dose time the drop happened for
    state: str = WAITING
    resolved_at: datetime | None = None
    _fired: set[int] = field(default_factory=set)

    def rung_time(self, index: int) -> datetime:
        return self.started + timedelta(minutes=self.config.rungs[index].offset_minutes)

    def due_rungs(self, now: datetime) -> list[tuple[int, Rung]]:
        """Unfired rungs whose time has come, in ladder order. Nothing is due
        once the dose is picked up or the tray closed."""
        if self.state != WAITING:
            return []
        return [
            (i, rung)
            for i, rung in enumerate(self.config.rungs)
            if i not in self._fired and self.rung_time(i) <= now
        ]

    def mark_fired(self, index: int) -> None:
        self._fired.add(index)

    def next_wake(self) -> datetime | None:
        """Earliest unfired rung time, or None when nothing remains."""
        if self.state != WAITING:
            return None
        remaining = [self.rung_time(i) for i in range(len(self.config.rungs)) if i not in self._fired]
        return min(remaining, default=None)

    def pickup(self, at: datetime) -> None:
        if self.state == WAITING:
            self.state = PICKED_UP
            self.resolved_at = at

    def close(self, at: datetime) -> None:
        if self.state == WAITING:
            self.state = CLOSED
            self.resolved_at = at
