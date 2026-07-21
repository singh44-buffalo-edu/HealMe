# HealMeNow — App Store listing kit

Everything to paste into App Store Connect, written to be truthful and to
survive review per the strategy in [APPSTORE.md](APPSTORE.md) §6. Update the
demo-server URL/credentials placeholders before submitting.

## App record

| Field | Value |
| --- | --- |
| Name | **HealMeNow** |
| Subtitle (30 chars) | `Your health record, your server` (31 chars — alt: `Self-hosted health record`) |
| Bundle ID | `cloud.antriksh.healmenow` |
| SKU | `healmenow-001` |
| Primary category | Medical |
| Secondary category | Health & Fitness |
| Age rating | Medical/Treatment Information → "Infrequent/Mild"; everything else None/No |
| Price | Free |
| Privacy Policy URL | *(pending — GitHub Pages / antriksh.cloud)* |
| Support URL | https://github.com/singh44-buffalo-edu/HealMe (or antriksh.cloud page) |

## Description

> HealMeNow is a personal health record that lives on YOUR server — not
> ours, not anyone's cloud. Connect it to your own self-hosted Medplum
> instance and every medication, dose log, check-in, vital, lab result and
> document stays on infrastructure you own and control.
>
> TRACK WHAT MATTERS
> • Medication schedule with a clear Today view — take, skip, correct, or
>   backdate any dose, including yesterday's
> • Life-critical medications are always flagged, in every state
> • Daily check-ins for mood, energy, sleep, and symptoms
> • Vitals and labs with trends, reference ranges, and provenance — you
>   always see whether a value was hand-logged, imported, read from a
>   document, or synced from Apple Health
>
> WORKS OFFLINE
> Log doses and check-ins with no connection; everything queues securely on
> device and syncs when your server is reachable — with honest status
> banners, never silent loss.
>
> APPLE HEALTH, ON YOUR TERMS
> Optional read-only sync brings steps, heart rate, sleep, weight, blood
> pressure, SpO₂ and temperature into your own record. Off by default.
>
> AI THAT KNOWS ITS PLACE
> Optional AI summaries organize your data for clinician visits — clearly
> labeled, never diagnostic, disabled until you configure a provider, with
> a fully local AI option. Every AI-derived value is marked.
>
> PRIVATE BY ARCHITECTURE
> The developer operates no servers and collects nothing. No analytics, no
> trackers, no accounts with us. The app talks only to the server you
> point it at.
>
> HealMeNow requires a self-hosted Medplum server (free, open source —
> setup guide included in the project repository). It is a record
> organizer and discussion aid, not a medical device, and provides no
> medical advice.

## Keywords (100 chars)

`medication,tracker,adherence,health record,self-hosted,medplum,FHIR,vitals,labs,private,EHR,pill`

## What's New (v1.0.0)

> First release: medication tracking with offline logging, daily check-ins,
> vitals & labs with trends, Apple Health import, document ingestion with
> review, and optional AI summaries — all against your own self-hosted
> server.

## App Privacy questionnaire (Connect → App Privacy)

- "Do you or your third-party partners collect data from this app?" →
  **No, we do not collect data from this app.**
- Rationale if a reviewer pushes back: data stored on the user's own
  self-hosted server is not collected by the developer; fallback answer per
  APPSTORE.md §3 is Health & Fitness data, "Linked to user", not used for
  tracking, with the note that the server is user-operated.
- The bundled `PrivacyInfo.xcprivacy` already declares: no tracking, zero
  collected data types, Required-Reason API (UserDefaults, CA92.1).

## Review notes (paste into App Review Information)

> HealMeNow is a personal health-record organizer for people who self-host
> their own record server (open-source Medplum). The developer operates no
> backend; the app connects only to a server the user runs themselves.
>
> DEMO ACCESS: a demonstration server with synthetic sample data is
> available for review at:
>   Server URL (enter on the sign-in screen): https://DEMO-HOST/
>   Email: demo@healmenow.example    Password: SET-ME
> All data on the demo server is synthetic. No real patient data exists.
>
> NETWORK/ATS: the app uses default App Transport Security with two narrow
> exceptions: NSAllowsLocalNetworking (self-hosted home-LAN case) and an
> exception for the user's own Tailscale VPN hostnames (*.ts.net), whose
> traffic is always WireGuard-encrypted despite the http scheme. Any other
> remote hostname must be HTTPS. An in-app banner warns the user whenever
> a configured connection is genuinely unencrypted.
>
> MEDICAL POSITIONING (guideline 5.1.3): the app organizes the user's own
> data. It provides no diagnosis, no dosing advice, and no treatment
> recommendations anywhere. AI features are optional, bring-your-own-key,
> disabled by default (the demo account has them off — you will see the
> designed "configure a provider" states), and every AI output carries a
> visible disclaimer and provenance label.
>
> Apple Health: read-only, opt-in via an explicit toggle in Settings →
> Apple Health; data goes only to the user's own server.

## Screenshots required

- 6.9" (iPhone 16/17 Pro Max class) — mandatory
- 6.5" (iPhone 11 Pro Max/XS Max class) — mandatory
Suggested set (per APPSTORE.md): Today, Adherence, Vitals, Labs, Review.
Generate: boot simulator, sign into the local stack, ⌘S — or
`xcrun simctl io booted screenshot out.png`.

## Submission checklist

1. [ ] Privacy policy URL live
2. [ ] ASC app record created (name HealMeNow, bundle `cloud.antriksh.healmenow`)
3. [ ] ASC API key (.p8 + Key ID + Issuer ID) → headless `make ios-upload`
4. [ ] Demo server deployed with HTTPS + seeded synthetic data + demo account
       (scripts/deploy_demo_vm.sh; DEPLOYMENT.md Part 4)
5. [ ] Build uploaded, attached to the version
6. [ ] Screenshots 6.9" + 6.5" uploaded
7. [ ] Description/keywords/support URL/privacy URL filled (this file)
8. [ ] App Privacy questionnaire answered (this file)
9. [ ] Age rating questionnaire (this file)
10. [ ] Review notes with demo credentials (this file)
11. [ ] Submit for Review
