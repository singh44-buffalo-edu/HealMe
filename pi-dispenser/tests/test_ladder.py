"""Escalation ladder: config + per-dose state machine (time injected)."""

from datetime import datetime, timedelta, timezone

import pytest

from pi_dispenser.ladder import CLOSED, DEFAULT_RUNGS, PICKED_UP, WAITING, DoseLadder, LadderConfig, Rung

UTC = timezone.utc
T0 = datetime(2026, 7, 15, 19, 0, 0, tzinfo=UTC)


def test_default_ladder_matches_the_design():
    config = LadderConfig.default()
    assert [(r.offset_minutes, r.action) for r in config.rungs] == [
        (0, "chime"),
        (15, "push"),
        (45, "ask-why"),
        (120, "close-tray"),
    ]
    assert config.log_missed_at_final_rung is True  # design: "T+2h tray retracts · logged missed"
    assert config.family_alert_recipient is None  # design: "Never — no family alert"


def test_rungs_fire_in_order_as_time_passes():
    ladder = DoseLadder(config=LadderConfig.default(), started=T0)
    assert ladder.state == WAITING

    due = ladder.due_rungs(T0)
    assert [r.action for _, r in due] == ["chime"]
    ladder.mark_fired(due[0][0])

    assert ladder.due_rungs(T0 + timedelta(minutes=14)) == []
    due = ladder.due_rungs(T0 + timedelta(minutes=15))
    assert [r.action for _, r in due] == ["push"]
    ladder.mark_fired(due[0][0])

    # a very late wake fires everything remaining, in ladder order
    due = ladder.due_rungs(T0 + timedelta(hours=3))
    assert [r.action for _, r in due] == ["ask-why", "close-tray"]


def test_next_wake_is_earliest_unfired_rung():
    ladder = DoseLadder(config=LadderConfig.default(), started=T0)
    assert ladder.next_wake() == T0
    for index, _ in ladder.due_rungs(T0):
        ladder.mark_fired(index)
    assert ladder.next_wake() == T0 + timedelta(minutes=15)


def test_pickup_cancels_all_remaining_rungs():
    ladder = DoseLadder(config=LadderConfig.default(), started=T0)
    ladder.mark_fired(0)
    ladder.pickup(T0 + timedelta(minutes=7))
    assert ladder.state == PICKED_UP
    assert ladder.due_rungs(T0 + timedelta(hours=5)) == []
    assert ladder.next_wake() is None


def test_close_ends_the_ladder():
    ladder = DoseLadder(config=LadderConfig.default(), started=T0)
    ladder.close(T0 + timedelta(hours=2))
    assert ladder.state == CLOSED
    assert ladder.due_rungs(T0 + timedelta(hours=5)) == []
    # closing is terminal — a later pickup() does not resurrect it
    ladder.pickup(T0 + timedelta(hours=6))
    assert ladder.state == CLOSED


def test_config_from_dict_and_defaults():
    config = LadderConfig.from_dict({})
    assert config.rungs == DEFAULT_RUNGS

    custom = LadderConfig.from_dict(
        {
            "rungs": [
                {"offset_minutes": 0, "action": "chime"},
                {"offset_minutes": 30, "action": "close-tray"},
            ],
            "log_missed_at_final_rung": False,
            "family_alert_recipient": "RelatedPerson/ma",
        }
    )
    assert [(r.offset_minutes, r.action) for r in custom.rungs] == [(0, "chime"), (30, "close-tray")]
    assert custom.log_missed_at_final_rung is False
    assert custom.family_alert_recipient == "RelatedPerson/ma"


def test_config_validation():
    with pytest.raises(ValueError, match="strictly increasing"):
        LadderConfig(rungs=(Rung(10, "chime"), Rung(5, "push")))
    with pytest.raises(ValueError, match="final rung"):
        LadderConfig(rungs=(Rung(0, "close-tray"), Rung(10, "push")))
    with pytest.raises(ValueError, match="unknown ladder action"):
        Rung(0, "family-siren")
    with pytest.raises(ValueError, match="at least one rung"):
        LadderConfig(rungs=())
