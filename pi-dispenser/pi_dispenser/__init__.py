"""HealMeDaily Raspberry Pi pill-dispenser agent (Phase 8).

Simulator-first: everything runs and tests on a dev machine with zero
hardware. The FHIR shapes follow FHIR-MAPPING.md §3 (dose event identity),
§5 (cartridges) and §9 (dispenser) exactly.

Not a certified medical device. The dispenser never decides whether a
medication may be taken.
"""

__version__ = "0.1.0"
