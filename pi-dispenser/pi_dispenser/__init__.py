"""HealMeDaily Raspberry Pi pill-dispenser agent (Phase 8).

Simulator-first: everything runs and tests on a dev machine with zero
hardware. The FHIR shapes follow FHIR-MAPPING.md §3 (dose event identity),
§5 (cartridges) and §9 (dispenser) exactly.

Not a certified medical device. The dispenser never decides whether a
medication may be taken.

Module map (who calls whom):

    cli.py       entrypoints (sim / status / run); wires everything below
    agent.py     the main loop: dispense -> watch pickup -> escalate
    hal.py       hardware abstraction (SimulatedBackend | GpioBackend) + clocks
    schedule.py  MedicationRequests + cartridge Devices -> today's DoseSlots
    ladder.py    user-configured escalation ladder + per-dose state machine
    events.py    FHIR payload builders + sinks (DryRunSink | MedplumSink)
    client.py    OAuth2 client-credentials Medplum REST client
    consts.py    identifier systems / CodeSystem / extension URLs (§7 + §9)

This package deliberately never imports from ai-service/ or frontend/ —
packages don't cross package boundaries in this repo (shared shapes are
duplicated and pinned by tests instead; see schedule.py's identity coupling).
"""

__version__ = "0.1.0"
