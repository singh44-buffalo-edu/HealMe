#!/usr/bin/env python
"""Seed the Medplum CDR with the core resources + sample data so dashboards
aren't empty.

Run via `make seed` after `make bootstrap`. One transaction Bundle (plain
FHIR REST via httpx, admin credentials) + a handful of targeted fixups;
writes MEDPLUM_PATIENT_ID back into .env for the frontend/service/scripts.

Idempotency = ifNoneExist semantics. Every entry carries a stable business
identifier (systems in FHIR-MAPPING.md §7) and its transaction request says
`ifNoneExist: identifier=<system>|<value>`. Server behavior when the search
matches: the entry is SKIPPED and returns 200 + the existing resource — the
payload in this script is NOT applied as an update. Two consequences:
  - re-running never duplicates, but
  - reshaping a resource here does nothing to an already-seeded instance.
    That is exactly why the post-transaction fixups at the bottom exist: they
    PUT the delta onto found resources (retire superseded questionnaire
    versions, cadence extension, life-critical flag, authoredOn anchor,
    cartridge->dispenser mount, app-config timezone). Add a fixup whenever
    you upgrade the shape of a resource that earlier seeds already created.

Sample-only resources are tagged `https://healmedaily.local/fhir/tags|seed-sample`
for easy purge later. The Patient and Questionnaires are real (untagged).

Creates:
  - the single Patient (the owner)
  - the app-config Basic (owner timezone from HMD_TIME_ZONE — the
    reminders-runner bot reads it; kept in sync as a fixup)
  - the daily check-in Questionnaire
  - 2 sample Medications + MedicationRequests (rename/replace with the real
    regimen in the app later)
  - 2 cartridge Devices (one deliberately below its low-stock threshold)
  - 14 days of sample MedicationAdministrations (taken + a few skipped)
  - sample weight / mood / energy / sleep Observations
"""

from __future__ import annotations

import sys
import uuid
from datetime import date, datetime, time as dtime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from dotenv import dotenv_values, set_key

REPO = Path(__file__).resolve().parents[1]
ENV_PATH = REPO / ".env"

BASE_URL = "https://healmedaily.local/fhir"
IDENT = BASE_URL + "/identifier"
CS_OBS = BASE_URL + "/CodeSystem/observation"
CS_ADHERENCE = BASE_URL + "/CodeSystem/adherence-reason"
CS_DEVICE = BASE_URL + "/CodeSystem/device"
EXT_DEVICE_MED = BASE_URL + "/StructureDefinition/device-assigned-medication"
EXT_LIFE_CRITICAL = BASE_URL + "/StructureDefinition/medicationrequest-life-critical"
EXT_CADENCE = BASE_URL + "/StructureDefinition/questionnaire-cadence"  # valueCode D|W|M
CS_APP_CONFIG = BASE_URL + "/CodeSystem/app-config"
EXT_TIME_ZONE = BASE_URL + "/StructureDefinition/app-config-time-zone"  # IANA zone
TAGS = BASE_URL + "/tags"
SEED_TAG = {"system": TAGS, "code": "seed-sample", "display": "Seed sample data"}

LOINC = "http://loinc.org"
UCUM = "http://unitsofmeasure.org"


def log(msg: str) -> None:
    print(f"[seed] {msg}")


def die(msg: str) -> None:
    print(f"[seed] FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def env(key: str, default: str = "") -> str:
    return (dotenv_values(ENV_PATH).get(key) or default).strip()


def get_token(base: str) -> str:
    """Access token for seeding — admin first, service credentials fallback."""
    # Seeding is an owner-level operation: prefer the admin login. The service
    # ClientApplication is bound to the least-privilege 'service/healmedaily-ai'
    # AccessPolicy (scripts/bootstrap.py) and can no longer create the Patient,
    # Questionnaires or MedicationRequests this script seeds.
    admin_email, admin_password = env("HMD_ADMIN_EMAIL"), env("HMD_ADMIN_PASSWORD")
    if admin_email and admin_password:
        sys.path.insert(0, str(Path(__file__).parent))
        from bootstrap import password_login

        token = password_login(base, admin_email, admin_password)
        if token:
            return token
        log("admin login failed — falling back to client credentials")
    client_id, client_secret = env("MEDPLUM_CLIENT_ID"), env("MEDPLUM_CLIENT_SECRET")
    if not client_id or not client_secret:
        die("no admin or client credentials in .env — run `make bootstrap` first")
    resp = httpx.post(
        base + "oauth2/token",
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=10,
    )
    if resp.status_code != 200:
        die(f"token failed: {resp.status_code} {resp.text[:300]}")
    return resp.json()["access_token"]


def ident(suffix: str, value: str) -> dict:
    """Business identifier under the project system (FHIR-MAPPING.md §7)."""
    return {"system": f"{IDENT}/{suffix}", "value": value}


def entry(resource: dict, suffix: str, value: str, url: str | None = None) -> dict:
    """Transaction entry with conditional create on the stable identifier.

    fullUrl is a uuid5 OF the identifier, so it is stable across runs and
    intra-bundle references built with ref() always point at the same
    logical resource, whether it is being created now or already exists.
    """
    resource.setdefault("identifier", []).append(ident(suffix, value))
    return {
        "fullUrl": f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, f'{IDENT}/{suffix}|{value}')}",
        "resource": resource,
        "request": {
            "method": "POST",
            "url": url or resource["resourceType"],
            "ifNoneExist": f"identifier={IDENT}/{suffix}|{value}",
        },
    }


def ref(e: dict) -> dict:
    """Intra-bundle reference by fullUrl; the server rewrites it to the real
    id — the existing resource's id when ifNoneExist matched."""
    return {"reference": e["fullUrl"]}


def local_dt(d: date, hhmm: str, tz: ZoneInfo) -> str:
    """ISO datetime at HH:MM in the owner's timezone — clinical timestamps
    always carry an offset (FHIR-MAPPING.md §1)."""
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime.combine(d, dtime(h, m), tzinfo=tz).isoformat(timespec="seconds")


def main() -> None:
    """Build the transaction bundle, POST it, verify, then run the fixups."""
    base = env("MEDPLUM_BASE_URL", "http://localhost:8103/")
    if not base.endswith("/"):
        base += "/"
    tz = ZoneInfo(env("HMD_TIME_ZONE", "America/Los_Angeles"))
    today = datetime.now(tz).date()
    token = get_token(base)

    entries: list[dict] = []

    # --- Patient (the owner) ------------------------------------------------
    patient = entry(
        {
            "resourceType": "Patient",
            "active": True,
            "name": [
                {
                    "given": [env("HMD_PATIENT_GIVEN_NAME", "HealMeDaily")],
                    "family": env("HMD_PATIENT_FAMILY_NAME", "User"),
                }
            ],
        },
        "patient",
        env("HMD_PATIENT_IDENTIFIER", "healmedaily-user"),
    )
    entries.append(patient)
    subject = ref(patient)

    # --- Daily check-in Questionnaire ---------------------------------------
    q_url = f"{BASE_URL}/Questionnaire/daily-check-in"
    q_version = "1.1.0"
    questionnaire = {
        "fullUrl": f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, q_url + q_version)}",
        "resource": {
            "resourceType": "Questionnaire",
            "url": q_url,
            "version": q_version,
            "name": "DailyCheckIn",
            "title": "Daily check-in",
            "status": "active",
            "extension": [{"url": EXT_CADENCE, "valueCode": "D"}],
            "item": [
                {
                    "linkId": "rested",
                    "text": "Waking up, how rested did you feel? (1 = exhausted, 5 = fully rested)",
                    "type": "integer",
                    "code": [
                        {
                            "system": CS_OBS,
                            "code": "rested",
                            "display": "Rested on waking (1-5)",
                        }
                    ],
                },
                {
                    "linkId": "sleep-hours",
                    "text": "Hours slept last night",
                    "type": "decimal",
                    "code": [
                        {
                            "system": CS_OBS,
                            "code": "sleep-duration",
                            "display": "Sleep duration (h)",
                        }
                    ],
                },
                {
                    "linkId": "mood",
                    "text": "Mood (1 = worst, 10 = best)",
                    "type": "integer",
                    "code": [
                        {"system": CS_OBS, "code": "mood", "display": "Mood (1-10)"}
                    ],
                },
                {
                    "linkId": "energy",
                    "text": "Energy (1 = worst, 10 = best)",
                    "type": "integer",
                    "code": [
                        {"system": CS_OBS, "code": "energy", "display": "Energy (1-10)"}
                    ],
                },
                {
                    "linkId": "stress",
                    "text": "Peak stress today (0 = none, 10 = worst)",
                    "type": "integer",
                    "code": [
                        {
                            "system": CS_OBS,
                            "code": "stress",
                            "display": "Peak stress (0-10)",
                        }
                    ],
                },
                {
                    "linkId": "symptoms",
                    "text": "Any new symptom today — anything at all?",
                    "type": "string",
                },
                {
                    "linkId": "notes",
                    "text": "Anything notable today?",
                    "type": "string",
                },
            ],
        },
        "request": {
            "method": "POST",
            "url": "Questionnaire",
            "ifNoneExist": f"url={q_url}&version={q_version}",
        },
    }
    entries.append(questionnaire)

    # --- Weekly reflection questionnaire (spec §12: social/purpose/activity/recovery)
    weekly_url = f"{BASE_URL}/Questionnaire/weekly-reflection"
    weekly_version = "1.0.0"

    def q_item(
        link_id: str,
        text: str,
        item_type: str,
        code: str | None = None,
        display: str | None = None,
    ) -> dict:
        item: dict = {"linkId": link_id, "text": text, "type": item_type}
        if code:
            item["code"] = [
                {"system": CS_OBS, "code": code, "display": display or text}
            ]
        return item

    entries.append(
        {
            "fullUrl": f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, weekly_url + weekly_version)}",
            "resource": {
                "resourceType": "Questionnaire",
                "url": weekly_url,
                "version": weekly_version,
                "name": "WeeklyReflection",
                "title": "Weekly reflection",
                "status": "active",
                "extension": [{"url": EXT_CADENCE, "valueCode": "W"}],
                "item": [
                    q_item(
                        "social-contact",
                        "Meaningful contact with people you care about this week? (1 = none, 5 = lots)",
                        "integer",
                        "social-contact",
                        "Social contact (1-5)",
                    ),
                    q_item(
                        "loneliness",
                        "Any loneliness this week? (0 = none, 10 = a lot)",
                        "integer",
                        "loneliness",
                        "Loneliness (0-10)",
                    ),
                    q_item(
                        "purpose-alignment",
                        "Did your days feel aligned with what matters to you? (1 = not at all, 5 = fully)",
                        "integer",
                        "purpose-alignment",
                        "Purpose alignment (1-5)",
                    ),
                    q_item(
                        "activity-mvpa",
                        "Minutes of moderate-to-vigorous activity this week?",
                        "integer",
                        "activity-mvpa",
                        "MVPA (min/week)",
                    ),
                    q_item(
                        "activity-strength",
                        "Strength sessions this week?",
                        "integer",
                        "activity-strength",
                        "Strength sessions (/week)",
                    ),
                    q_item(
                        "recovery-days",
                        "Recovery days this week (no hard strain)?",
                        "integer",
                        "recovery-days",
                        "Recovery days (/week)",
                    ),
                    q_item(
                        "recurring-symptom",
                        "Any recurring ache or symptom you keep ignoring?",
                        "string",
                    ),
                    q_item(
                        "rx-question",
                        "Anything to raise with your prescriber?",
                        "string",
                    ),
                ],
            },
            "request": {
                "method": "POST",
                "url": "Questionnaire",
                "ifNoneExist": f"url={weekly_url}&version={weekly_version}",
            },
        }
    )

    # --- Sample medications + requests --------------------------------------
    def medication(slug: str, text: str) -> dict:
        return entry(
            {
                "resourceType": "Medication",
                "code": {"text": text},
                "status": "active",
                "meta": {"tag": [SEED_TAG]},
            },
            "medication",
            slug,
        )

    def med_request(
        slug: str, med: dict, sig: str, times: list[str], life_critical: bool = False
    ) -> dict:
        resource = {
            "resourceType": "MedicationRequest",
            "status": "active",
            "intent": "order",
            "authoredOn": (today - timedelta(days=90)).isoformat(),
            "subject": subject,
            "medicationReference": ref(med),
            "dosageInstruction": [
                {
                    "text": sig,
                    "timing": {
                        "repeat": {
                            "frequency": len(times),
                            "period": 1,
                            "periodUnit": "d",
                            "timeOfDay": times,
                        }
                    },
                }
            ],
            "meta": {"tag": [SEED_TAG]},
        }
        if life_critical:
            resource["extension"] = [{"url": EXT_LIFE_CRITICAL, "valueBoolean": True}]
        return entry(resource, "medication-request", slug)

    med_a = medication("sample-med-a", "Sample Medication A 10 mg tablet")
    med_b = medication("sample-med-b", "Sample Medication B 500 mg tablet")
    # FHIR `time` requires seconds: HH:MM:SS
    req_a = med_request(
        "sample-med-a-daily",
        med_a,
        "1 tablet daily at 09:00",
        ["09:00:00"],
        life_critical=True,
    )
    req_b = med_request(
        "sample-med-b-bid",
        med_b,
        "1 tablet twice daily (09:00, 21:00)",
        ["09:00:00", "21:00:00"],
    )
    entries += [med_a, med_b, req_a, req_b]

    # --- Cartridges ----------------------------------------------------------
    def cartridge(
        slug: str, name: str, med: dict, capacity: int, remaining: int, threshold: int
    ) -> dict:
        def prop(code: str, value: int) -> dict:
            return {
                "type": {"coding": [{"system": CS_DEVICE, "code": code}]},
                "valueQuantity": [{"value": value, "unit": "doses"}],
            }

        return entry(
            {
                "resourceType": "Device",
                "status": "active",
                "deviceName": [{"name": name, "type": "user-friendly-name"}],
                "type": {
                    "coding": [{"system": CS_DEVICE, "code": "medication-cartridge"}]
                },
                "extension": [{"url": EXT_DEVICE_MED, "valueReference": ref(med)}],
                "property": [
                    prop("capacity", capacity),
                    prop("remaining-count", remaining),
                    prop("low-stock-threshold", threshold),
                ],
                "meta": {"tag": [SEED_TAG]},
            },
            "device",
            slug,
        )

    # Parent dispenser device — cartridges mount onto it via Device.parent
    # (FHIR-MAPPING §5/§9; no Device.patient — R4 means affixed-to-body).
    dispenser = entry(
        {
            "resourceType": "Device",
            "status": "active",
            "deviceName": [{"name": "Pi dispenser", "type": "user-friendly-name"}],
            "type": {"coding": [{"system": CS_DEVICE, "code": "pill-dispenser"}]},
            "meta": {"tag": [SEED_TAG]},
        },
        "device",
        "pi-dispenser",
    )
    cart_1 = cartridge(
        "cartridge-1", "Cartridge 1", med_a, capacity=30, remaining=12, threshold=5
    )
    cart_2 = cartridge(
        "cartridge-2", "Cartridge 2", med_b, capacity=30, remaining=3, threshold=5
    )
    for cart in (cart_1, cart_2):
        cart["resource"]["parent"] = ref(dispenser)
    entries += [dispenser, cart_1, cart_2]

    # --- 14 days of sample administrations ----------------------------------
    def administration(
        req: dict,
        med: dict,
        device: dict | None,
        slug_base: str,
        d: date,
        hhmm: str,
        reason: str | None,
    ) -> dict:
        admin: dict = {
            "resourceType": "MedicationAdministration",
            "subject": subject,
            "medicationReference": ref(med),
            "request": ref(req),
            "effectiveDateTime": local_dt(d, hhmm, tz),
            "meta": {"tag": [SEED_TAG]},
        }
        if device:
            admin["device"] = [ref(device)]
        if reason:
            admin["status"] = "not-done"
            admin["statusReason"] = [
                {
                    "coding": [
                        {
                            "system": CS_ADHERENCE,
                            "code": reason,
                            "display": "Skipped by user"
                            if reason == "user-skipped"
                            else "Marked missed by user",
                        }
                    ],
                    "text": "Sample data",
                }
            ]
        else:
            admin["status"] = "completed"
        return entry(
            admin, "medication-administration", f"{slug_base}-{d.isoformat()}T{hhmm}"
        )

    # Deliberate adherence gaps (values = days ago) so the Adherence dashboard
    # has all three log states to render: skipped, user-marked-missed, and an
    # evening-dose miss pattern. Days with NO entry at all are not modeled
    # here — "no log => no resource" (FHIR-MAPPING.md §3).
    med_a_skipped = {3, 9}
    med_a_missed = {6}
    med_b_missed_evening = {2, 6}
    for days_ago in range(1, 15):
        d = today - timedelta(days=days_ago)
        reason_a = (
            "user-skipped"
            if days_ago in med_a_skipped
            else "user-marked-missed"
            if days_ago in med_a_missed
            else None
        )
        entries.append(
            administration(
                req_a, med_a, cart_1, "sample-med-a-daily", d, "09:00", reason_a
            )
        )
        entries.append(
            administration(req_b, med_b, cart_2, "sample-med-b-bid", d, "09:00", None)
        )
        reason_b_pm = "user-marked-missed" if days_ago in med_b_missed_evening else None
        entries.append(
            administration(
                req_b, med_b, cart_2, "sample-med-b-bid", d, "21:00", reason_b_pm
            )
        )

    # --- Sample observations -------------------------------------------------
    def observation(slug: str, resource: dict) -> dict:
        resource.update(
            {
                "resourceType": "Observation",
                "subject": subject,
                "meta": {"tag": [SEED_TAG]},
            }
        )
        return entry(resource, "quick-observation", slug)

    for days_ago, kg in [
        (88, 71.8),
        (81, 71.5),
        (74, 71.6),
        (67, 71.2),
        (60, 71.3),
        (53, 70.9),
        (46, 71.0),
        (39, 70.7),
        (32, 70.8),
        (25, 70.5),
        (18, 70.3),
        (13, 70.6),
        (10, 70.2),
        (7, 70.4),
        (4, 69.9),
        (1, 70.1),
    ]:
        d = today - timedelta(days=days_ago)
        entries.append(
            observation(
                f"seed-weight-{d.isoformat()}",
                {
                    "status": "final",
                    "category": [
                        {
                            "coding": [
                                {
                                    "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                                    "code": "vital-signs",
                                }
                            ]
                        }
                    ],
                    "code": {
                        "coding": [
                            {
                                "system": LOINC,
                                "code": "29463-7",
                                "display": "Body weight",
                            }
                        ]
                    },
                    "effectiveDateTime": local_dt(d, "08:30", tz),
                    "valueQuantity": {
                        "value": kg,
                        "unit": "kg",
                        "system": UCUM,
                        "code": "kg",
                    },
                },
            )
        )

    survey_cat = [
        {
            "coding": [
                {
                    "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                    "code": "survey",
                }
            ]
        }
    ]
    # Deterministic pseudo-variation (no RNG) so re-seeds are reproducible
    # while the charts still look plausibly noisy.
    for days_ago in range(1, 31):
        d = today - timedelta(days=days_ago)
        mood = 6 + (days_ago % 3) - (1 if days_ago % 11 == 0 else 0)
        energy = 5 + ((days_ago + 1) % 4) - (1 if days_ago % 13 == 0 else 0)
        sleep_h = 6.5 + (days_ago % 3) * 0.5 - (0.5 if days_ago % 7 == 0 else 0)
        entries.append(
            observation(
                f"seed-mood-{d.isoformat()}",
                {
                    "status": "final",
                    "category": survey_cat,
                    "code": {
                        "coding": [
                            {"system": CS_OBS, "code": "mood", "display": "Mood (1-10)"}
                        ]
                    },
                    "effectiveDateTime": local_dt(d, "21:30", tz),
                    "valueInteger": mood,
                },
            )
        )
        entries.append(
            observation(
                f"seed-energy-{d.isoformat()}",
                {
                    "status": "final",
                    "category": survey_cat,
                    "code": {
                        "coding": [
                            {
                                "system": CS_OBS,
                                "code": "energy",
                                "display": "Energy (1-10)",
                            }
                        ]
                    },
                    "effectiveDateTime": local_dt(d, "21:30", tz),
                    "valueInteger": energy,
                },
            )
        )
        sleep_start = local_dt(d - timedelta(days=1), "23:30", tz)
        sleep_end = local_dt(d, "07:00", tz)
        entries.append(
            observation(
                f"seed-sleep-{d.isoformat()}",
                {
                    "status": "final",
                    "category": survey_cat,
                    "code": {
                        "coding": [
                            {
                                "system": CS_OBS,
                                "code": "sleep-duration",
                                "display": "Sleep duration",
                            }
                        ]
                    },
                    "effectivePeriod": {"start": sleep_start, "end": sleep_end},
                    "valueQuantity": {
                        "value": sleep_h,
                        "unit": "h",
                        "system": UCUM,
                        "code": "h",
                    },
                },
            )
        )

    # --- Sample symptoms ------------------------------------------------------
    for days_ago, text in [
        (21, "Mild headache in the evening"),
        (12, "Slight nausea after morning dose"),
        (6, "Mild headache in the evening"),
        (2, "Felt dizzy briefly after standing up"),
    ]:
        d = today - timedelta(days=days_ago)
        entries.append(
            observation(
                f"seed-symptom-{d.isoformat()}",
                {
                    "status": "final",
                    "category": survey_cat,
                    "code": {
                        "coding": [
                            {"system": CS_OBS, "code": "symptom", "display": "Symptom"}
                        ],
                        "text": "Symptom",
                    },
                    "effectiveDateTime": local_dt(d, "20:00", tz),
                    "valueString": text,
                },
            )
        )

    # --- Sample lab report (verified LOINC only; else text-only) --------------
    lab_cat = [
        {
            "coding": [
                {
                    "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                    "code": "laboratory",
                }
            ]
        }
    ]

    def lab(
        slug: str, d: date, code: dict, value: float, unit: str, low: float, high: float
    ) -> dict:
        return observation(
            slug,
            {
                "status": "final",
                "category": lab_cat,
                "code": code,
                "effectiveDateTime": local_dt(d, "10:00", tz),
                "valueQuantity": {"value": value, "unit": unit, "system": UCUM},
                "referenceRange": [
                    {
                        "low": {"value": low, "unit": unit},
                        "high": {"value": high, "unit": unit},
                    }
                ],
            },
        )

    lab_days = [(75, 14.1, 5.4, 38.0), (8, 13.6, 5.6, 42.0)]
    lab_entries_by_date: dict[str, list[dict]] = {}
    for days_ago, hgb, a1c, vitd in lab_days:
        d = today - timedelta(days=days_ago)
        day_labs = [
            lab(
                f"seed-lab-hgb-{d.isoformat()}",
                d,
                {
                    "coding": [
                        {
                            "system": LOINC,
                            "code": "718-7",
                            "display": "Hemoglobin [Mass/volume] in Blood",
                        }
                    ],
                    "text": "Hemoglobin",
                },
                hgb,
                "g/dL",
                13.0,
                17.0,
            ),
            lab(
                f"seed-lab-a1c-{d.isoformat()}",
                d,
                {
                    "coding": [
                        {"system": LOINC, "code": "4548-4", "display": "Hemoglobin A1c"}
                    ],
                    "text": "HbA1c",
                },
                a1c,
                "%",
                4.0,
                5.6,
            ),
            lab(
                f"seed-lab-vitd-{d.isoformat()}",
                d,
                {
                    "text": "Vitamin D (25-OH)"
                },  # no confident LOINC — text-only per mapping rules
                vitd,
                "ng/mL",
                30.0,
                100.0,
            ),
        ]
        entries.extend(day_labs)
        lab_entries_by_date[d.isoformat()] = day_labs

    for d_iso, day_labs in lab_entries_by_date.items():
        entries.append(
            entry(
                {
                    "resourceType": "DiagnosticReport",
                    "status": "final",
                    "code": {"text": "Routine blood panel"},
                    "subject": subject,
                    # 10:00 local with that date's correct UTC offset —
                    # borrow local_dt's suffix so DST transitions stay right.
                    "effectiveDateTime": f"{d_iso}T10:00:00"
                    + local_dt(date.fromisoformat(d_iso), "10:00", tz)[-6:],
                    "result": [ref(e) for e in day_labs],
                    "meta": {"tag": [SEED_TAG]},
                },
                "document",
                f"seed-labreport-{d_iso}",
            )
        )

    # --- POST the transaction ------------------------------------------------
    bundle = {"resourceType": "Bundle", "type": "transaction", "entry": entries}
    resp = httpx.post(
        base + "fhir/R4",
        json=bundle,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/fhir+json",
        },
        timeout=60,
    )
    if resp.status_code >= 400:
        die(f"transaction failed: {resp.status_code} {resp.text[:2000]}")
    result = resp.json()
    statuses = [
        e.get("response", {}).get("status", "?") for e in result.get("entry", [])
    ]
    created = sum(1 for s in statuses if s.startswith("201"))
    existing = sum(1 for s in statuses if s.startswith("200"))
    log(
        f"transaction ok: {created} created, {existing} already existed, {len(statuses)} total"
    )
    # ⚠️ Medplum gotcha (CLAUDE.md §9): transaction bundles are NOT
    # all-or-nothing on per-entry validation errors — valid entries commit
    # while an invalid one gets a per-entry 400, leaving references dangling.
    # So: check EVERY entry's response.status and die on any failure so a
    # partial seed never goes unnoticed.
    bad = [
        (i, e)
        for i, e in enumerate(result.get("entry", []))
        if not e.get("response", {}).get("status", "").startswith(("200", "201"))
    ]
    for i, e in bad:
        sent = entries[i]["resource"]["resourceType"] if i < len(entries) else "?"
        log(f"UNEXPECTED entry[{i}] ({sent}): {e.get('response', {})}")
    if bad:
        die(f"{len(bad)} bundle entries did not succeed")

    # ------------------------- post-transaction fixups -------------------------
    # ifNoneExist SKIPS existing resources (200 + old body, payload ignored),
    # so shape upgrades introduced after a resource first seeded must be
    # applied explicitly with a read-check-PUT. Each fixup below is a former
    # schema upgrade; all are no-ops once applied.
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/fhir+json",
    }

    # Fixup: retire superseded questionnaire versions so `status=active`
    # search resolves uniquely to the current one (frontend + QR->Obs bot rely
    # on this — FHIR-MAPPING.md §2 "Check-in extras"); also backfill the
    # cadence extension on a current version created before cadences existed.
    old_versions = httpx.get(
        base + "fhir/R4/Questionnaire",
        params={"url": q_url, "_count": 20},
        headers=headers,
        timeout=15,
    ).json()
    for e in old_versions.get("entry", []):
        res = e["resource"]
        if res.get("version") != q_version and res.get("status") == "active":
            res["status"] = "retired"
            put = httpx.put(
                base + f"fhir/R4/Questionnaire/{res['id']}",
                json=res,
                headers=headers,
                timeout=15,
            )
            if put.status_code >= 400:
                die(
                    f"retiring questionnaire v{res.get('version')} failed: {put.status_code}"
                )
            log(f"retired daily-check-in v{res.get('version')}")
        elif res.get("version") == q_version and not any(
            x.get("url") == EXT_CADENCE for x in res.get("extension", [])
        ):
            res["extension"] = res.get("extension", []) + [
                {"url": EXT_CADENCE, "valueCode": "D"}
            ]
            put = httpx.put(
                base + f"fhir/R4/Questionnaire/{res['id']}",
                json=res,
                headers=headers,
                timeout=15,
            )
            if put.status_code >= 400:
                die(f"cadence ext update failed: {put.status_code}")
            log("ensured cadence=D on daily check-in")
    # Fixup: life-critical flag on sample med A (owner decision 2026-07-13 —
    # display prominence only, never dose logic; CLAUDE.md §8).
    find_req = httpx.get(
        base + "fhir/R4/MedicationRequest",
        params={
            "identifier": f"{IDENT}/medication-request|sample-med-a-daily",
            "_count": 1,
        },
        headers=headers,
        timeout=15,
    ).json()
    if find_req.get("entry"):
        req = find_req["entry"][0]["resource"]
        exts = req.get("extension", [])
        if not any(e.get("url") == EXT_LIFE_CRITICAL for e in exts):
            req["extension"] = exts + [{"url": EXT_LIFE_CRITICAL, "valueBoolean": True}]
            put = httpx.put(
                base + f"fhir/R4/MedicationRequest/{req['id']}",
                json=req,
                headers=headers,
                timeout=15,
            )
            if put.status_code >= 400:
                die(
                    f"life-critical flag update failed: {put.status_code} {put.text[:300]}"
                )
            log("ensured life-critical flag on sample-med-a-daily")

    # Existing sample MedicationRequests predate the authoredOn anchor —
    # ensure it so the frontend can bound historical dose slots correctly.
    reqs = httpx.get(
        base + "fhir/R4/MedicationRequest",
        params={"status": "active", "_count": 100},
        headers=headers,
        timeout=15,
    ).json()
    for e in reqs.get("entry", []):
        res = e["resource"]
        if not res.get("authoredOn"):
            res["authoredOn"] = (today - timedelta(days=90)).isoformat()
            put = httpx.put(
                base + f"fhir/R4/MedicationRequest/{res['id']}",
                json=res,
                headers=headers,
                timeout=15,
            )
            if put.status_code >= 400:
                die(f"authoredOn backfill failed: {put.status_code}")
            log(f"backfilled authoredOn on MedicationRequest/{res['id']}")

    # Existing cartridge Devices predate the parent dispenser — ensure the
    # Device.parent mount (FHIR-MAPPING §5) on already-seeded cartridges.
    find_disp = httpx.get(
        base + "fhir/R4/Device",
        params={"identifier": f"{IDENT}/device|pi-dispenser", "_count": 1},
        headers=headers,
        timeout=15,
    ).json()
    if find_disp.get("entry"):
        disp_id = find_disp["entry"][0]["resource"]["id"]
        carts = httpx.get(
            base + "fhir/R4/Device",
            params={"type": f"{CS_DEVICE}|medication-cartridge", "_count": 100},
            headers=headers,
            timeout=15,
        ).json()
        for e in carts.get("entry", []):
            res = e["resource"]
            if not res.get("parent"):
                res["parent"] = {"reference": f"Device/{disp_id}"}
                put = httpx.put(
                    base + f"fhir/R4/Device/{res['id']}",
                    json=res,
                    headers=headers,
                    timeout=15,
                )
                if put.status_code >= 400:
                    die(f"cartridge parent mount failed: {put.status_code}")
                log(f"mounted Device/{res['id']} onto the dispenser")

    # Fixup: the app-config Basic (identifier {IDENT}/app-config|app-config,
    # code app-config) carries the owner's IANA timezone from HMD_TIME_ZONE so
    # server-side bots (reminders-runner) derive dose-slot identity in the
    # OWNER's zone instead of the medplum-server container's UTC clock.
    # Read-check-PUT (not ifNoneExist in the bundle) so an edited .env value
    # propagates on re-seed; the resource is real config, not sample data.
    tz_name = env("HMD_TIME_ZONE", "America/Los_Angeles")
    find_cfg = httpx.get(
        base + "fhir/R4/Basic",
        params={"identifier": f"{IDENT}/app-config|app-config", "_count": 1},
        headers=headers,
        timeout=15,
    ).json()
    if find_cfg.get("entry"):
        cfg = find_cfg["entry"][0]["resource"]
        current_tz = next(
            (
                e.get("valueString")
                for e in cfg.get("extension", [])
                if e.get("url") == EXT_TIME_ZONE
            ),
            None,
        )
        if current_tz != tz_name:
            cfg["extension"] = [
                e for e in cfg.get("extension", []) if e.get("url") != EXT_TIME_ZONE
            ] + [{"url": EXT_TIME_ZONE, "valueString": tz_name}]
            put = httpx.put(
                base + f"fhir/R4/Basic/{cfg['id']}",
                json=cfg,
                headers=headers,
                timeout=15,
            )
            if put.status_code >= 400:
                die(f"app-config timezone update failed: {put.status_code}")
            log(f"updated app-config timezone -> {tz_name}")
    else:
        post = httpx.post(
            base + "fhir/R4/Basic",
            json={
                "resourceType": "Basic",
                "identifier": [
                    {"system": f"{IDENT}/app-config", "value": "app-config"}
                ],
                "code": {
                    "coding": [
                        {
                            "system": CS_APP_CONFIG,
                            "code": "app-config",
                            "display": "App configuration",
                        }
                    ],
                    "text": "App configuration",
                },
                "created": today.isoformat(),
                "extension": [{"url": EXT_TIME_ZONE, "valueString": tz_name}],
            },
            headers=headers,
            timeout=15,
        )
        if post.status_code >= 400:
            die(f"app-config create failed: {post.status_code} {post.text[:300]}")
        log(f"created app-config Basic (timezone {tz_name})")

    # Persist the Patient id for the service/frontend
    find = httpx.get(
        base + "fhir/R4/Patient",
        params={
            "identifier": f"{IDENT}/patient|{env('HMD_PATIENT_IDENTIFIER', 'healmedaily-user')}",
            "_count": 1,
        },
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    ).json()
    if find.get("entry"):
        patient_id = find["entry"][0]["resource"]["id"]
        set_key(ENV_PATH, "MEDPLUM_PATIENT_ID", patient_id, quote_mode="never")
        log(f"patient: Patient/{patient_id} (saved to .env)")
    else:
        die("patient not found after seeding — investigate")


if __name__ == "__main__":
    main()
