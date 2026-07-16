# pi-dispenser — HealMeDaily Raspberry Pi pill dispenser (Phase 8)

**Not a certified medical device. The dispenser never decides whether a medication may be taken.**

The physical machine (design ref: *Web — Dispenser Suite*): a lidded cylinder with 8
colour-rimmed trays stacked on a central spindle, each tray split into 7 pie wedges
(one dose per wedge, one wedge per weekday). At dose time the spindle rotates, today's
wedge opens, and the pills fall through the cone funnel to the base tray, which sits
on a load cell. Confirmation-first: the machine *offers* the dose and *observes* the
pickup — it never withholds one, and inventory/timers/sensors never gate intake.

This package is **simulator-first**: everything runs and tests on a dev machine with
zero hardware (`SimulatedBackend` + injected clock). The GPIO backend activates only
on a Pi.

## What it writes (and what it never writes)

All shapes follow `FHIR-MAPPING.md` §3/§5/§9 — the dispenser writes **dose events
only**, idempotently (stable identifiers + conditional create):

| Moment | Resource |
| --- | --- |
| Wedge drop at dose time | `MedicationDispense` (completed, `whenHandedOver` = T0) |
| Pickup / confirmed intake | `MedicationAdministration` — the *same logical dose event* the app's manual tap would create (identifier = request + scheduled occurrence), with the `administration-verification` extension: `weight` \| `camera` \| `self` (priority weight > camera > self) |
| Escalation rung | `CommunicationRequest` (medium local code `chime` / `push` / `ask-why`) |
| Final rung, only if configured | `MedicationAdministration` `not-done` + `user-marked-missed`, in one transaction with a `Provenance` attributing the write to the dispenser agent |

Never: Conditions, Observations, regimen changes, or device telemetry. Timeliness is
computed by readers (`effectiveDateTime − whenHandedOver`), never stored.

## The escalation ladder — yours, always

Default (from the *Dose Ritual* design), overridable via `--ladder my-ladder.json`:

| Rung | Action |
| --- | --- |
| T+0 | chime — dispenser only, gentle |
| T+15 | re-chime + push to phone/watch |
| T+45 | ask, don't nag — "Skip tonight? Tell me why" (a reason is data too) |
| T+2h | base tray retracts; logs `not-done` + `user-marked-missed` **only if the config says so** |
| Never | **no family alert unless you configure one** |

```json
{
  "rungs": [
    { "offset_minutes": 0, "action": "chime" },
    { "offset_minutes": 15, "action": "push" },
    { "offset_minutes": 45, "action": "ask-why" },
    { "offset_minutes": 120, "action": "close-tray" }
  ],
  "log_missed_at_final_rung": true,
  "family_alert_recipient": null
}
```

No missed-dose resource exists before the final rung — an unlogged dose stays
"unlogged" on the schedule, exactly like the rest of the app (§3). A pickup after the
user marked a dose skipped updates the same logical event (version-checked), never a
duplicate.

## Run the simulator (no hardware, no Medplum needed)

```bash
# from the repo root
make pi-sim        # accelerated dry-run day, prints the FHIR payload sequence
make pi-test       # pytest for this package

# or directly
PYTHONPATH=pi-dispenser ai-service/.venv/bin/python -m pi_dispenser \
    sim --scenario pi-dispenser/scenarios/day.json --speed 60 --dry-run
```

`--speed N` = simulated seconds per real second; the sim jumps between events and
caps each hop at 1 real second, so a full day always finishes in seconds
(`--speed 0` = no pacing at all). Without `--dry-run`, events are written to Medplum
when `DISPENSER_MEDPLUM_*` is configured. `python -m pi_dispenser status` shows the
current configuration and today's slots.

Scenario files script the day deterministically: fixture `MedicationRequest`s +
cartridge `Device`s (med→tray via the `device-assigned-medication` extension +
`Device.parent` → this dispenser), hardware availability flags, and timed pickups
(`"via": "sensor"` or `"tap"`). See `scenarios/day.json`.

## Pi setup

1. Raspberry Pi OS (64-bit, Bookworm or later), Python 3.12+.
2. `python3 -m venv .venv && .venv/bin/pip install .` (the package needs only
   `httpx`; hardware extras on the Pi: `gpiozero`, `hx711`, `picamera2`).
3. In the Medplum app (Project Admin), create a **dedicated ClientApplication** for
   the dispenser and scope it with an AccessPolicy limited to dose events
   (MedicationDispense, MedicationAdministration, CommunicationRequest, Provenance +
   read of MedicationRequest/Medication/Device/Patient). LAN only — never expose it.
4. Create the dispenser `Device` (type local code `pill-dispenser`) and point each
   cartridge's `Device.parent` at it (Devices page, or Medplum app).
5. `.env` next to the checkout (see the systemd unit):

   ```
   DISPENSER_MEDPLUM_BASE_URL=http://<medplum-host>:8103/
   DISPENSER_MEDPLUM_CLIENT_ID=...
   DISPENSER_MEDPLUM_CLIENT_SECRET=...
   DISPENSER_MEDPLUM_PATIENT_ID=...
   ```

6. `sudo cp systemd/pi-dispenser.service /etc/systemd/system/ && sudo systemctl enable --now pi-dispenser`

### Calibration (before first real use)

The constants at the top of `pi_dispenser/hal.py` are **placeholders, not facts** —
every rig differs. Measure on your hardware:

- **Wedge / base-tray servos** — find the closed and open pulse widths with a slow
  sweep (start centred, step ±0.05 ms). Do not run a servo against its mechanical
  stop.
- **Spindle** — count steps for one full revolution with your microstepping and gear
  ratio, divide by 8 trays; verify tray alignment visually for all 8 positions.
- **Load cell (HX711)** — record the raw reading with an empty base tray
  (`LOADCELL_OFFSET`), then with a known mass (`LOADCELL_SCALE = raw / grams`).
  Re-check after moving the machine.
- **Bay camera** — the pill-vision check (design 5b) is a later phase; until then the
  camera path only verifies "tray empty" and the GPIO capture is not enabled.

### Safety notes

- **Not a certified medical device. The dispenser never decides whether a medication
  may be taken.**
- Confirmation-first: it offers a dose and observes; a jammed wedge or empty
  cartridge must never read as "do not take your medication" — the user's manual log
  in the app always stands, and the machine's writes never overwrite a user's log.
- Escalation is the user's ladder: change it, silence it, or turn the missed-dose log
  off; no family alert exists unless explicitly configured.
- Low stock is a supply warning only (§5) — inventory never gates dosing.
- The agent's webhook is fire-and-forget on the LAN; its failure never affects
  dispensing or logging.
