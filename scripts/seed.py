#!/usr/bin/env python
"""Seed the Medplum CDR with the core resources + sample data so dashboards
aren't empty.

Idempotent: every entry uses a stable identifier + conditional create
(ifNoneExist), so re-running never duplicates. Sample-only resources are
tagged `https://healmedaily.local/fhir/tags|seed-sample` for easy purge later.

Creates:
  - the single Patient (the owner)
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
    client_id, client_secret = env("MEDPLUM_CLIENT_ID"), env("MEDPLUM_CLIENT_SECRET")
    if not client_id or not client_secret:
        die("no client credentials in .env — run `make bootstrap` first")
    resp = httpx.post(
        base + "oauth2/token",
        data={"grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret},
        timeout=10,
    )
    if resp.status_code != 200:
        die(f"token failed: {resp.status_code} {resp.text[:300]}")
    return resp.json()["access_token"]


def ident(suffix: str, value: str) -> dict:
    return {"system": f"{IDENT}/{suffix}", "value": value}


def entry(resource: dict, suffix: str, value: str, url: str | None = None) -> dict:
    """Transaction entry with conditional create on the stable identifier."""
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
    return {"reference": e["fullUrl"]}


def local_dt(d: date, hhmm: str, tz: ZoneInfo) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime.combine(d, dtime(h, m), tzinfo=tz).isoformat(timespec="seconds")


def main() -> None:
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
    questionnaire = {
        "fullUrl": f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, q_url)}",
        "resource": {
            "resourceType": "Questionnaire",
            "url": q_url,
            "version": "1.0.0",
            "name": "DailyCheckIn",
            "title": "Daily check-in",
            "status": "active",
            "item": [
                {
                    "linkId": "mood",
                    "text": "Mood (1 = worst, 10 = best)",
                    "type": "integer",
                    "code": [{"system": CS_OBS, "code": "mood", "display": "Mood (1-10)"}],
                },
                {
                    "linkId": "energy",
                    "text": "Energy (1 = worst, 10 = best)",
                    "type": "integer",
                    "code": [{"system": CS_OBS, "code": "energy", "display": "Energy (1-10)"}],
                },
                {
                    "linkId": "sleep-hours",
                    "text": "Hours slept last night",
                    "type": "decimal",
                    "code": [{"system": CS_OBS, "code": "sleep-duration", "display": "Sleep duration (h)"}],
                },
                {"linkId": "notes", "text": "Anything notable today?", "type": "string"},
            ],
        },
        "request": {"method": "POST", "url": "Questionnaire", "ifNoneExist": f"url={q_url}&version=1.0.0"},
    }
    entries.append(questionnaire)

    # --- Sample medications + requests --------------------------------------
    def medication(slug: str, text: str) -> dict:
        return entry(
            {"resourceType": "Medication", "code": {"text": text}, "status": "active", "meta": {"tag": [SEED_TAG]}},
            "medication",
            slug,
        )

    def med_request(slug: str, med: dict, sig: str, times: list[str]) -> dict:
        return entry(
            {
                "resourceType": "MedicationRequest",
                "status": "active",
                "intent": "order",
                "subject": subject,
                "medicationReference": ref(med),
                "dosageInstruction": [
                    {
                        "text": sig,
                        "timing": {
                            "repeat": {"frequency": len(times), "period": 1, "periodUnit": "d", "timeOfDay": times}
                        },
                    }
                ],
                "meta": {"tag": [SEED_TAG]},
            },
            "medication-request",
            slug,
        )

    med_a = medication("sample-med-a", "Sample Medication A 10 mg tablet")
    med_b = medication("sample-med-b", "Sample Medication B 500 mg tablet")
    # FHIR `time` requires seconds: HH:MM:SS
    req_a = med_request("sample-med-a-daily", med_a, "1 tablet daily at 09:00", ["09:00:00"])
    req_b = med_request("sample-med-b-bid", med_b, "1 tablet twice daily (09:00, 21:00)", ["09:00:00", "21:00:00"])
    entries += [med_a, med_b, req_a, req_b]

    # --- Cartridges ----------------------------------------------------------
    def cartridge(slug: str, name: str, med: dict, capacity: int, remaining: int, threshold: int) -> dict:
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
                "type": {"coding": [{"system": CS_DEVICE, "code": "medication-cartridge"}]},
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

    cart_1 = cartridge("cartridge-1", "Cartridge 1", med_a, capacity=30, remaining=12, threshold=5)
    cart_2 = cartridge("cartridge-2", "Cartridge 2", med_b, capacity=30, remaining=3, threshold=5)
    entries += [cart_1, cart_2]

    # --- 14 days of sample administrations (med A daily 09:00) --------------
    skipped_days = {3, 9}
    for days_ago in range(1, 15):
        d = today - timedelta(days=days_ago)
        when = local_dt(d, "09:00", tz)
        slug = f"sample-med-a-daily-{d.isoformat()}T09:00"
        admin: dict = {
            "resourceType": "MedicationAdministration",
            "subject": subject,
            "medicationReference": ref(med_a),
            "request": ref(req_a),
            "device": [ref(cart_1)],
            "effectiveDateTime": when,
            "meta": {"tag": [SEED_TAG]},
        }
        if days_ago in skipped_days:
            admin["status"] = "not-done"
            admin["statusReason"] = [
                {
                    "coding": [{"system": CS_ADHERENCE, "code": "user-skipped", "display": "Skipped by user"}],
                    "text": "Skipped (sample data)",
                }
            ]
        else:
            admin["status"] = "completed"
        entries.append(entry(admin, "medication-administration", slug))

    # --- Sample observations -------------------------------------------------
    def observation(slug: str, resource: dict) -> dict:
        resource.update({"resourceType": "Observation", "subject": subject, "meta": {"tag": [SEED_TAG]}})
        return entry(resource, "quick-observation", slug)

    for days_ago, kg in [(13, 70.6), (10, 70.2), (7, 70.4), (4, 69.9), (1, 70.1)]:
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
                    "code": {"coding": [{"system": LOINC, "code": "29463-7", "display": "Body weight"}]},
                    "effectiveDateTime": local_dt(d, "08:30", tz),
                    "valueQuantity": {"value": kg, "unit": "kg", "system": UCUM, "code": "kg"},
                },
            )
        )

    survey_cat = [
        {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "survey"}]}
    ]
    for days_ago in range(1, 8):
        d = today - timedelta(days=days_ago)
        mood = 6 + (days_ago % 3)
        energy = 5 + ((days_ago + 1) % 4)
        sleep_h = 6.5 + (days_ago % 3) * 0.5
        entries.append(
            observation(
                f"seed-mood-{d.isoformat()}",
                {
                    "status": "final",
                    "category": survey_cat,
                    "code": {"coding": [{"system": CS_OBS, "code": "mood", "display": "Mood (1-10)"}]},
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
                    "code": {"coding": [{"system": CS_OBS, "code": "energy", "display": "Energy (1-10)"}]},
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
                    "code": {"coding": [{"system": CS_OBS, "code": "sleep-duration", "display": "Sleep duration"}]},
                    "effectivePeriod": {"start": sleep_start, "end": sleep_end},
                    "valueQuantity": {"value": sleep_h, "unit": "h", "system": UCUM, "code": "h"},
                },
            )
        )

    # --- POST the transaction ------------------------------------------------
    bundle = {"resourceType": "Bundle", "type": "transaction", "entry": entries}
    resp = httpx.post(
        base + "fhir/R4",
        json=bundle,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/fhir+json"},
        timeout=60,
    )
    if resp.status_code >= 400:
        die(f"transaction failed: {resp.status_code} {resp.text[:2000]}")
    result = resp.json()
    statuses = [e.get("response", {}).get("status", "?") for e in result.get("entry", [])]
    created = sum(1 for s in statuses if s.startswith("201"))
    existing = sum(1 for s in statuses if s.startswith("200"))
    log(f"transaction ok: {created} created, {existing} already existed, {len(statuses)} total")
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

    # Persist the Patient id for the service/frontend
    find = httpx.get(
        base + "fhir/R4/Patient",
        params={"identifier": f"{IDENT}/patient|{env('HMD_PATIENT_IDENTIFIER', 'healmedaily-user')}", "_count": 1},
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
