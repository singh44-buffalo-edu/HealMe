# HealMeDaily iOS app

Native SwiftUI iPhone app for the HealMeDaily personal EHR. It talks
directly to your self-hosted Medplum server (FHIR REST + OAuth2/PKCE) and to
the ai-service — the exact same backends as the web frontend, no new server
pieces.

```
ios/
  project.yml           XcodeGen spec (source of truth — .xcodeproj is generated)
  HealMeDailyKit/       SwiftPM package: FHIR models, Medplum client, dose engine,
                        check-in cadence engine, quick-log builders, ai-service client.
                        Pure Foundation — unit-testable on macOS (`swift test`).
  HealMeDaily/          App target: SwiftUI screens, design-system port, Face ID lock,
                        local dose reminders, camera→ingest capture.
  scripts/make_icon.swift  regenerates the app icon PNG
```

## What's in the app

| Screen | Backend it uses |
| --- | --- |
| Today (dose panel: due/overdue/taken, tap to log, backdating) | Medplum FHIR — same idempotent `MedicationAdministration` writes as the web app |
| Medications (read-only list, life-critical flags, cartridge stock) | Medplum FHIR |
| Adherence dashboard (%, streak, heat calendar, per-med) | pure client-side math over the shared slot model |
| Check-ins (D/W/M cadence, native questionnaire renderer) | Medplum FHIR (`QuestionnaireResponse`, period-idempotent) |
| Quick add (weight, sleep, mood/energy, symptoms, vitals, rx-questions) | Medplum FHIR (verified LOINC/UCUM + local codes, identical to web) |
| Vitals dashboard (BP/HR/temp/SpO₂/glucose, Swift Charts) | Medplum FHIR |
| Assistant (record-grounded Q&A with citations) + NL quick capture | ai-service `/assistant` |
| Health Review (AI review + deterministic data summary, PDF share) | ai-service `/health-review` |
| Documents (camera/photo/file upload, structured imports, review queue) | ai-service `/ingest`, `/import` |
| Settings (server URLs, Face ID lock, dose reminders, AI routing) | ai-service `/ai`, local device settings |

Safety behavior is identical to the web app: no-log ⇒ no-resource, AI output
always labeled (indigo + ✦ AI pill), extraction proposals never commit
without explicit approval, no clinical judgment anywhere, disclaimer on
every AI surface.

Dose-slot identity (`{request-slug}-{date}T{HH:MM}`) is byte-identical to
the frontend/Pi dispenser, so logging a dose on the phone and correcting it
on the web (or vice versa) updates the same logical record. The unit tests
in `HealMeDailyKit/Tests` are a port of `frontend/src/fhir.test.ts` and must
stay green in lockstep.

## Build & run

Prereqs: Xcode 15+ (a current simulator runtime installed via
Xcode ▸ Settings ▸ Components to actually run it), `brew install xcodegen`.

```bash
make ios-test      # Kit unit tests (runs natively on macOS, no simulator needed)
make ios-project   # xcodegen generate → ios/HealMeDaily.xcodeproj
make ios-build     # compile for iOS simulator (no signing)
open ios/HealMeDaily.xcodeproj   # run on a simulator or your iPhone from Xcode
```

Troubleshooting: if `make ios-build` fails at the asset-catalog step with
`No available simulator runtimes for platform iphonesimulator` right after
installing Xcode's iOS platform (`xcodebuild -downloadPlatform iOS`), the
downloaded runtime image usually needs a **reboot** before CoreSimulator
registers it (`xcrun simctl runtime list` says Ready but
`xcrun simctl list runtimes` stays empty). Everything except the asset
catalog builds regardless:
`xcodebuild … EXCLUDED_SOURCE_FILE_NAMES="*.xcassets" build`.

## Pointing the phone at your stack

`localhost` on the phone is the phone. In the sign-in screen (or Settings)
set:

- **Medplum server URL** — `http://<your-Mac's-LAN-IP>:8103/` while on the
  same Wi-Fi, e.g. `http://192.168.1.20:8103/`
- **AI service URL** — `http://<same-IP>:8000/`

For use away from home, put the stack behind HTTPS (Tailscale is the
low-effort option; any reverse proxy with a real cert works) and use that
hostname. Plain HTTP is permitted only for local/raw-IP addresses (Apple's
ATS local-networking exemption) — a remote **hostname** must be HTTPS or
iOS blocks the connection. Sign in with the same
Medplum email/password as the web app (register accounts in the Medplum app
at `:3000`, never in this app).

Sessions are stored in the iOS Keychain (device-only, never backed up to
other devices). Tokens are bound to the server URL that minted them —
changing the URL signs you out.

## Privacy notes

- Health data flows ONLY between the phone and your own server (plus
  whatever AI provider you explicitly route a feature to — always disclosed
  in-app with the amber boundary row).
- Dose reminders are computed on-device; by default the lock-screen text
  hides medication names ("Medication due") until you opt in.
- Optional Face ID/passcode lock gates the whole app.
- No analytics, no tracking, no third-party SDKs. `PrivacyInfo.xcprivacy`
  declares zero collected data types.

## App Store

See [APPSTORE.md](../APPSTORE.md) for the full signing → TestFlight →
App Store Connect walkthrough, including the App Review caveats specific to
a self-hosted-backend app (demo server requirement, ATS justification,
App Privacy questionnaire answers).
