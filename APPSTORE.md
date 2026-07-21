# Shipping the HealMeDaily iOS app to the App Store

Step-by-step from this repo to TestFlight and the App Store. The project
builds unsigned out of the box; everything Apple-account-specific happens in
your Apple Developer account and Xcode — none of it is (or should be)
committed to the repo.

Honest framing first: this is a **single-user app for your own self-hosted
server**. You do not need the App Store to run it on your own iPhone:

| Route | Cost | Good for |
| --- | --- | --- |
| Xcode direct install (free account) | free | your own phone; re-sign every 7 days |
| **TestFlight** (paid account) | $99/yr | your own phone + family, 90-day builds, no review hoops for internal testers — **the practical sweet spot for this app** |
| App Store | $99/yr | public distribution; App Review applies (see caveats below) |

## 0. Prereqs

- Apple Developer Program membership ($99/yr) for TestFlight/App Store:
  <https://developer.apple.com/programs/enroll/>
- Xcode 15+ signed into that account (Xcode ▸ Settings ▸ Accounts).
- `brew install xcodegen`, then `make ios-project` to generate
  `ios/HealMeDaily.xcodeproj`.

## 1. Bundle identity & signing

1. Bundle id: the default is **`cloud.antriksh.healmenow`** (change it in
   [ios/project.yml](ios/project.yml) → `PRODUCT_BUNDLE_IDENTIFIER`, then
   re-run `make ios-project`).
2. Put your Team ID in `ios/Signing.xcconfig` (gitignored; `make
   ios-project` seeds it from `Signing.xcconfig.example` — Team ID is in
   Xcode ▸ Settings ▸ Accounts). This survives `.xcodeproj` regeneration,
   so you never re-enter signing in Xcode. First build per Mac still wants
   Xcode signed into the account (Settings ▸ Accounts) so automatic signing
   can mint the App ID + certificates. The project ships a
   HealthKit entitlement (read-only sync, opt-in in Settings) — Xcode adds
   the HealthKit capability to the App ID automatically; App Review will
   expect the Apple Health toggle to be demonstrable, and the App Privacy
   answers below still hold (health data goes only to the user's own
   server, the developer collects nothing).
3. **Push (optional).** The project ships an `aps-environment` entitlement
   (`development`; Xcode/App Store signing rewrites it to `production`).
   Enable **Push Notifications** on the App ID and create an **APNs Auth Key
   (.p8)** in the Developer portal; put its Key ID, your Team ID and the .p8
   into the server's `.env` (`APNS_*`) — the key is a SERVER secret and is
   never in the app binary. Set `PUSH_SUBSCRIPTION_SECRET` + `AI_SERVICE_PUBLIC_URL`
   and run `make bots` to wire the Medplum Subscription. Push is entirely
   optional: with no APNs config the entitlement is harmless and nothing is
   sent. Notification payloads carry no medical content, so the App Privacy
   answers are unaffected.
4. Sanity check on a real device: select your iPhone, Run. Sign in against
   `http://<mac-lan-ip>:8103/`.

## 2. App Store Connect record

1. <https://appstoreconnect.apple.com> → My Apps → **+ New App**.
2. Platform iOS · Name (must be globally unique — e.g. "HealMeNow") ·
   primary language · your bundle id (`cloud.antriksh.healmenow`) · SKU
   (any string).
3. Category: **Medical** (or Health & Fitness). Age rating questionnaire:
   the medical/treatment question → "Infrequent/Mild Medical Information";
   everything else No.

## 3. App Privacy questionnaire (Connect → App Privacy)

The developer (you) operates **no server** and collects **nothing**; data
moves only between the app and infrastructure the *user* owns. Truthful
answers:

- "Do you or your third-party partners collect data from this app?" → **No,
  we do not collect data from this app.**
  (Data stored on the user's own self-hosted server is not "collected" by
  the developer; if a reviewer pushes back, the fallback is Health & Fitness
  data, "Linked to user", not used for tracking, with a note that the server
  is user-operated.)
- Privacy policy URL is mandatory: a one-page static page stating the app
  transmits health data only to the user's own self-hosted server and the
  AI providers the user explicitly configures; the developer receives
  nothing. (Host it anywhere, e.g. GitHub Pages.)

## 4. Build & upload

In Xcode: Product ▸ Destination ▸ **Any iOS Device (arm64)** → Product ▸
**Archive** → Organizer opens → **Distribute App** → App Store Connect →
Upload. Xcode handles signing, the privacy manifest and the icon (both are
already in the target).

CLI alternative (uses `ios/Signing.xcconfig` + `ios/ExportOptions.plist`,
uploads directly to App Store Connect):

```bash
make ios-archive   # signed release archive -> ios/build/HealMeDaily.xcarchive
make ios-upload    # export + upload to App Store Connect (destination: upload)
```

## 5. TestFlight (recommended stopping point)

Connect → TestFlight → the uploaded build finishes processing → add
yourself as an **internal tester** (no Beta App Review needed) → install via
the TestFlight app. Builds last 90 days; upload a new one when it expires.
For family caretakers later, internal testers (up to 100) are enough.

## 6. App Store submission — the honest caveats

App Review will install the app on their network, where your home server is
unreachable. Guideline 4.2 (minimum functionality) and 2.1 (app
completeness) are the risks. Mitigations, all in **App Review notes**:

1. **Demo server**: stand up a throwaway copy of the stack on a cheap VM
   with HTTPS (the repo's [DEPLOYMENT.md](DEPLOYMENT.md) cloud guide does
   exactly this), run `make seed` for sample data, create a demo Medplum
   account, and put the URL + credentials in the review notes' demo-account
   fields. This is effectively required — without a reachable server the
   reviewer sees only a sign-in screen, which is a guaranteed rejection.
2. **ATS posture** (a good story, tell it): the app uses default ATS plus
   only `NSAllowsLocalNetworking` — plain HTTP works for LAN/raw-IP
   addresses (the self-hosted case), while any remote hostname must be
   HTTPS. Note for the reviewer: "The app connects exclusively to a server
   the user self-hosts; cleartext HTTP is limited to the local network,
   remote access requires HTTPS."
3. **Medical positioning**: the notes and the App Store description must
   state it is a personal record organizer, **not** a diagnostic/treatment
   tool, provides no medical advice, and every AI output carries an in-app
   disclaimer. (This maps to guideline 5.1.3 — health apps that could
   provide inaccurate advice get extra scrutiny; this app deliberately
   gives none.)
4. AI features: mention they are optional, BYO-key, disabled until the user
   configures a provider, and that the demo account has them off (the
   reviewer then sees the designed "configure a provider" states).

Screenshots: 6.9" (iPhone 15 Pro Max class) and 6.5" sets are required —
run the simulator, ⌘S. Use Today, Adherence, Vitals, Assistant.

Then: add the build to the version, fill description/keywords/support URL,
Submit for Review.

## 7. Updates

Bump `MARKETING_VERSION` (and `CURRENT_PROJECT_VERSION` for every upload) in
`ios/project.yml`, `make ios-project`, archive, upload, submit. Keep
`make ios-test` green — it holds the dose-engine parity tests that keep the
phone and the web app writing the same records.
