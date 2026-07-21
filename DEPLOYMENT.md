# HealMeDaily — dev environment & cloud deployment guide

Read [ONBOARDING.md](./ONBOARDING.md) first for the mental model. This guide covers two things:
setting up a development environment from a fresh machine, and the three ways to make the app
reachable beyond the machine it runs on — with the privacy trade-offs stated honestly, because
**this app's core promise is "your record never leaves your hardware," and two of the three
cloud options break that promise in different degrees.**

---

## Part 1 — Development environment (fresh machine)

### macOS

```bash
# 1. Toolchain (system python is too old; docker via Desktop or colima)
brew install --cask docker            # or: brew install colima docker
brew install python@3.12 node tesseract poppler

# 2. Clone + install everything (frontend, bots, ai-service venv)
git clone <your-remote-or-copy> healmedaily && cd healmedaily
make install

# 3. Configuration
cp .env.example .env                  # then read it top to bottom once

# 4. Boot the FHIR stack (FIRST boot runs migrations — minutes, be patient)
make up

# 5. One-time: first user + project + service credentials -> .env
#    Fresh installs only: set MEDPLUM_REGISTER_ENABLED 'true' in
#    infra/docker-compose.yml, `make up` again, then:
make bootstrap
#    ...then flip registration back to 'false' and `make up` again.

# 6. Sample data, bots, dev servers
make seed                             # idempotent; safe to re-run always
make bots                             # build + deploy the 4 bots (needs super-admin, see .env)
make dev                              # frontend :5173 + ai-service :8000 (hot reload)

# 7. Prove it works — this is the definition of "working" in this repo
make smoke
```

Daily loop: edit → `make check` (full gate: ruff, oxlint, pytest, vitest, tsc, builds) →
`make smoke` before ending a phase. `make pi-sim` runs the dispenser simulator with no hardware.

### Linux (Debian/Ubuntu)

Same flow; replace brew with: `apt install docker.io docker-compose-v2 python3.12-venv nodejs npm
tesseract-ocr poppler-utils`. Everything else is identical — the Makefile only assumes docker,
python3.12 and node.

### Ports (dev)

| :5173 Vite | :8000 ai-service | :8103 FHIR | :3000 Medplum admin | :5432 pg | :6379 redis |

Gotcha that costs people an afternoon: if the prod overlay (`make prod-up`) is running, **:8000
is the container, not your `make dev` uvicorn** — new endpoints will 404 until you rebuild the
container or stop it.

---

## Part 2 — Choosing a deployment model

| Option | Where the record lives | Effort | Fits the privacy promise? |
| --- | --- | --- | --- |
| **A. Tailscale (recommended)** | Your own machine at home | ~30 min | **Yes — fully** |
| **B. Your own cloud VM** | A VPS you rent | ~2–3 h | Partially — you administer it, but the provider owns the hardware |
| **C. Medplum hosted cloud** | Medplum Inc's multi-tenant cloud | ~1 h | No — a third party has custody of the CDR |

The honest recommendation for a single-user personal health record: **Option A.** You get
"access my record from anywhere, phone included" without moving the record anywhere. Choose B
only if the home machine can't stay on, and read its hardening checklist as mandatory, not
optional. C is listed for completeness; it trades away the reason this app is self-hosted.

---

## Part 3 — Option A: Tailscale (access from anywhere, record stays home)

**This Mac's actual setup (2026-07-21, no-sudo variant):** the GUI app needs an
admin password to install, so this machine runs the brew *formula* in
userspace mode instead — functionally identical for inbound server traffic:

- `brew install tailscale` (binaries only, no system extension)
- daemon: `tailscaled --tun=userspace-networking
  --statedir=~/.local/share/tailscaled
  --socket=~/.local/share/tailscaled/tailscaled.sock`, kept alive by the
  LaunchAgent `~/Library/LaunchAgents/io.tailscale.tailscaled-userspace.plist`
- CLI needs the socket flag:
  `tailscale --socket=$HOME/.local/share/tailscaled/tailscaled.sock <cmd>`
  (alias: `alias ts='tailscale --socket=$HOME/.local/share/tailscaled/tailscaled.sock'`)
- node hostname: `healmenow-mac`. (Switching to the Tailscale.app GUI later is
  fine — install it, stop the LaunchAgent, sign in; same tailnet, same IP.)

1. Sign the Mac into your tailnet (`ts up` prints a login URL) and install
   the Tailscale app on the iPhone (App Store) with the same account.
2. Run the normal prod stack locally: `make prod-up` (frontend :8080, ai-service :8000,
   Medplum :8103/:3000).
3. **iOS app**: point the sign-in server field at the Mac's tailnet IP —
   `http://100.x.y.z:8103/` (find it with `ts ip -4`). Plain HTTP is fine
   here: ATS exempts raw-IP URLs, and the tailnet link is WireGuard-encrypted
   end-to-end anyway. The ai-service is reached the same way (`:8000`).
4. **Web app on the phone (optional)**: serve over HTTPS inside the tailnet
   (`ts serve --bg 8080` → `https://healmenow-mac.<tailnet>.ts.net`), or just
   use the iOS app.

Limitations: only devices in your tailnet can reach it (that's the point); clinician share links
would need the clinician added as a tailnet guest or option B.

---

## Part 4 — Option B: your own cloud VM (full walkthrough)

**What changes when you do this:** the entire health record (Postgres + binary files) lives on
rented hardware. You are trusting the provider's physical security and your own ops discipline.
Mitigations below are required, not suggested.

### 4.1 Provision

- Any 4 GB RAM / 2 vCPU / 40 GB VM (Hetzner CX22, DigitalOcean 4GB, EC2 t3.medium…).
  Debian 12 or Ubuntu 24.04. Enable the provider's **encrypted volume** option if offered.
- DNS: create three A/AAAA records to the VM's IP:
  `app.you.example`, `fhir.you.example`, `medplum.you.example`. Add
  `ai.you.example` **only if** you consciously expose the ai-service (see the
  warning in 4.6 — it ships not-published because it has no auth of its own).

### 4.2 Base hardening (before the app ever starts)

```bash
adduser hmd && usermod -aG sudo,docker hmd     # never run as root
# SSH: keys only, no passwords, no root login (edit /etc/ssh/sshd_config)
apt update && apt install -y docker.io docker-compose-v2 ufw fail2ban unattended-upgrades git
ufw default deny incoming && ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
```

Full-disk/volume encryption: if the provider doesn't offer it, put Postgres + binary volumes on
a LUKS-encrypted disk. A stolen/decommissioned cloud disk must not contain a readable health record.

### 4.3 Deploy the stack

```bash
git clone <your-repo> healmedaily && cd healmedaily
cp .env.example .env
# In .env set (cloud section):
#   HMD_DOMAIN=you.example
#   HMD_ACME_EMAIL=you@example.com
#   HMD_DB_PASSWORD=<long random>        # NEVER the dev default
#   HMD_REDIS_PASSWORD=<long random>
docker compose -f infra/docker-compose.cloud.yml --env-file .env up -d --build
```

`infra/docker-compose.cloud.yml` is self-contained and differs from the local stack on purpose:
**only Caddy publishes ports (80/443)**; Postgres/Redis/Medplum/ai-service are internal-only;
all URLs derive from `HMD_DOMAIN`; TLS is automatic (Let's Encrypt via the checked-in
`infra/Caddyfile`); CORS is pinned to your two browser origins; registration is closed.

### 4.4 First boot (one time)

1. Temporarily set `MEDPLUM_REGISTER_ENABLED: 'true'` in the cloud compose, `up -d` again.
2. On your **laptop**, point bootstrap at the cloud API and run it:
   `MEDPLUM_BASE_URL=https://fhir.you.example/ make bootstrap` (writes credentials to `.env` —
   copy the updated `.env` to the VM, or run bootstrap on the VM directly).
3. Flip registration back to `'false'`, `up -d`.
4. `make seed` and `make bots` against the cloud URL the same way.
5. **Rotate the super-admin immediately**: `make rotate-superadmin`.

### 4.5 Verify

- `curl -sf https://fhir.you.example/healthcheck`
- Open `https://app.you.example` → sign in → VaultChip renders, dashboard loads.
- Open `https://medplum.you.example` and confirm the admin app talks to `fhir.you.example`
  (if it tries localhost, your medplum-app image version may need different runtime config —
  check the image docs for `MEDPLUM_BASE_URL` support).
- Upload a test PDF on Documents — presigned `/storage/` links must resolve (they bind to
  `MEDPLUM_BASE_URL`, which is why the compose sets it to the public fhir hostname).

### 4.6 Ongoing ops (the part people skip)

- **Backups, off-VM, encrypted**: nightly `python scripts/backup.py` (pg_dump + binary tar),
  then `age`/`gpg`-encrypt and ship to object storage or back home. Test a restore once.
- **Updates**: `unattended-upgrades` for the OS; Medplum images stay **pinned** — bump
  deliberately per the Upgrading-Server doc, never `latest`.
- **Watch the History page** — the boundary ledger and "who looked lately" work the same in
  the cloud and are your intrusion smoke alarm.
- Consider IP-allowlisting or basicauth on `medplum.you.example` (admin UI) in the Caddyfile.
- **ai-service authentication (as of 2026-07-17).** The ai-service now
  requires a valid Medplum session token on every endpoint except `/health`
  (`AI_REQUIRE_AUTH`, default **on** — see `ai-service/app/auth.py`): the web
  app and iOS app forward the signed-in session's token automatically. It
  still acts with its OWN full-access client-credentials token once past the
  gate, so before exposing it to anyone but the owner set
  `AI_OWNER_PROFILES` (comma-separated FHIR profile refs) — the gate then
  returns 403 to any non-owner session. With the gate on, `ai.{domain}` is no
  longer a bare one-curl PHI dump; still, the recommended posture is
  **internal-only** — the browser reaches it same-origin/over Tailscale and
  the Medplum push Subscription reaches it on the internal Docker network
  (`http://healmedaily-ai:8000`), so there is rarely a reason to publish it.
  If you do expose `ai.{domain}`, keep `AI_REQUIRE_AUTH=true`, set
  `AI_OWNER_PROFILES`, and Caddy `basic_auth` is then belt-and-suspenders,
  not the only lock. (The running pre-2026-07-17 build has NO gate — rebuild
  before relying on this.)
- **iOS push (APNs), optional.** To enable server-driven reminders on the
  phone, set in `.env` (server-only secrets): `APNS_KEY_ID`, `APNS_TEAM_ID`,
  the `.p8` at `APNS_KEY_PATH` (drop it in `data/secrets/`, which the cloud
  compose already mounts), `PUSH_SUBSCRIPTION_SECRET` (a long random value),
  and `AI_SERVICE_PUBLIC_URL=http://healmedaily-ai:8000` — the INTERNAL
  service name, because it is the Medplum **server** container that calls
  `/push/dispatch`, over the Docker network, so push works without exposing
  the ai-service publicly. Then `make bots` wires the Medplum Subscription.
  No APNs config ⇒ push is simply inert. Payloads carry no medication name.
- The UI's "On this device" VaultChip language is now aspirational — the record is on your VM.
  Consider that copy debt if option B becomes permanent.

### 4.7 Demo review server (App Store review)

For the disposable App-Review demo box — synthetic data only, AI deliberately unconfigured —
skip 4.3–4.5 and run `scripts/deploy_demo_vm.sh root@<vm-ip> demo.your.example` from this Mac
(one DNS A record required). It installs Docker + Caddy, rsyncs the repo (never `data/` or
`.env`), does the one-time registration flip + bootstrap + seed, creates the
`demo@healmenow.example` reviewer account, and prints the exact strings for
APPSTORE-LISTING.md. Port layout: `:443` → FHIR server (the iOS server URL), `:8443` →
ai-service, `:9443` → admin UI. Idempotent — re-run to ship code updates.

### What deliberately does NOT move to the cloud

- **BYOK AI keys** — `data/secrets/` goes with wherever the ai-service runs; if that's the VM,
  the file backend (0600) is used since there's no keychain. Your Anthropic/OpenAI key then
  lives on the VM — factor that into the decision.
- **The Pi dispenser** talks to the FHIR API; point `DISPENSER_MEDPLUM_BASE_URL` at the cloud
  URL and it works over the internet — but dose events then transit the cloud. With option A
  it stays LAN-only, which is the designed model.

---

## Part 5 — Option C: Medplum hosted cloud (least ops, least custody)

1. Create a project at app.medplum.com; create a ClientApplication; put its credentials in `.env`.
2. Frontend: deploy `frontend/` to Vercel/Netlify/Cloudflare Pages with
   `VITE_MEDPLUM_BASE_URL=https://api.medplum.com/` and `VITE_AI_SERVICE_URL=<your ai-service URL>`.
3. ai-service: one small VM or Fly.io machine running the `ai-service/` Dockerfile (it's stateless
   apart from `data/secrets`; mount a volume for it).
4. Bots deploy with the same `make bots` flow pointed at the hosted API.

Costs: hosted Medplum free tier exists; the trade is that your entire health record sits in a
third party's multi-tenant database, subject to their terms. The app will work — the premise won't.

---

## Quick reference

| Task | Command |
| --- | --- |
| Local dev | `make up` → `make dev` |
| Local prod-like | `make prod-up` (:8080) |
| Cloud stack | `docker compose -f infra/docker-compose.cloud.yml --env-file .env up -d --build` |
| Full gate | `make check` |
| End-to-end proof | `make smoke` |
| Backup | `make backup` (then encrypt + ship it off-box) |
| Rotate super-admin | `make rotate-superadmin` |
