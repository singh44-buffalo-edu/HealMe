#!/usr/bin/env bash
# deploy_demo_vm.sh — turn a fresh Ubuntu 24.04 VM into the App-Review demo
# server for the HealMeNow iOS app. Runs FROM THIS MAC:
#
#   scripts/deploy_demo_vm.sh <ssh-host> <domain>     e.g. root@1.2.3.4 demo.healmenow.example
#   DEMO_PASSWORD=... / ACME_EMAIL=... / DEMO_SKIP_DNS_CHECK=1 as env overrides.
#
# Port/URL layout (ONE DNS A record, ONE Let's Encrypt cert via host Caddy):
#   https://<domain>/       -> medplum-server :8103   the iOS app's server URL
#                                                     (= MEDPLUM_BASE_URL — presigned
#                                                     /storage links bind to it, CLAUDE.md §9)
#   https://<domain>:8443/  -> ai-service :8000       optional, app Settings; the
#                                                     AI_REQUIRE_AUTH session gate stays ON
#   https://<domain>:9443/  -> medplum-app :3000      admin UI, owner only
# Every container port is rebound to 127.0.0.1 by a generated demo overlay, so
# host Caddy is the only public listener — no ufw dependency (base hardening
# per DEPLOYMENT.md 4.2 remains the owner's job).
#
# Idempotent: re-runs rsync code changes, keep the VM's .env/data, and reuse
# the owner + demo accounts. AI stays UNCONFIGURED by design (the reviewer
# must see the "configure a provider" states) and only SYNTHETIC seed data
# ships (data/ and .env never leave this Mac) — both asserted below.
set -euo pipefail

SSH_HOST=${1:-}
DOMAIN=${2:-}
REMOTE_DIR=/opt/healmedaily
DEMO_EMAIL=demo@healmenow.example
SRC="$(cd "$(dirname "$0")/.." && pwd)"

die() { echo "FATAL: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
vm() { ssh -o BatchMode=yes "$SSH_HOST" "$@"; }

[ -n "$SSH_HOST" ] && [ -n "$DOMAIN" ] || die "usage: $0 <ssh-host> <domain>"
# Both values are interpolated into remote shells and configs — keep them tame.
[[ "$DOMAIN" =~ ^[A-Za-z0-9][A-Za-z0-9.-]+$ ]] || die "domain '$DOMAIN' looks wrong"
if [ -n "${DEMO_PASSWORD:-}" ]; then
  [[ "$DEMO_PASSWORD" =~ ^[A-Za-z0-9._-]{8,}$ ]] || die "DEMO_PASSWORD: >=8 chars of [A-Za-z0-9._-] only"
fi
for tool in ssh rsync dig curl; do command -v "$tool" >/dev/null || die "$tool not found on this Mac"; done

step "Preflight: DNS A record for $DOMAIN must point at the VM"
VM_IP=$(vm "curl -4fsS --max-time 10 https://api.ipify.org || hostname -I | awk '{print \$1}'")
[ -n "$VM_IP" ] || die "could not determine the VM's public IP over ssh"
DNS_IPS=$(dig +short A "$DOMAIN" | grep -E '^[0-9.]+$' || true)
if [ "${DEMO_SKIP_DNS_CHECK:-0}" != "1" ]; then
  [ -n "$DNS_IPS" ] || die "no A record for $DOMAIN — create one pointing at $VM_IP, wait for propagation, re-run"
  grep -qx "$VM_IP" <<<"$DNS_IPS" || die "$DOMAIN resolves to [$(echo "$DNS_IPS" | tr '\n' ' ')] but the VM is $VM_IP — fix DNS first (Let's Encrypt would fail); DEMO_SKIP_DNS_CHECK=1 to override"
fi
echo "    $DOMAIN -> $VM_IP OK"

step "Provisioning VM: Docker (official apt repo), Caddy, python3-venv, rsync"
vm "REMOTE_DIR='$REMOTE_DIR' bash -s" <<'EOSSH'
set -euo pipefail
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo -n"
export DEBIAN_FRONTEND=noninteractive
command -v curl >/dev/null || { $SUDO apt-get update -qq; $SUDO apt-get install -y -qq curl ca-certificates; }
if ! command -v docker >/dev/null; then
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | $SUDO tee /etc/apt/keyrings/docker.asc >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update -qq && $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
if ! command -v caddy >/dev/null; then
  $SUDO apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | $SUDO gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  $SUDO apt-get update -qq && $SUDO apt-get install -y -qq caddy
fi
dpkg -s python3-venv >/dev/null 2>&1 || $SUDO apt-get install -y -qq rsync python3-venv
$SUDO mkdir -p "$REMOTE_DIR" && $SUDO chown "$(id -un):$(id -gn)" "$REMOTE_DIR"
EOSSH

step "Rsyncing repo -> $SSH_HOST:$REMOTE_DIR (no .git/node_modules/.venv/data/ios/.env)"
EXCLUDES=(--exclude .git --exclude node_modules --exclude .venv --exclude data
  --exclude ios --exclude .env --exclude '*.xcodeproj' --exclude __pycache__
  --exclude .DS_Store --exclude 'personal-health-record-system 2')
# Belt-and-suspenders: prove the exclude list really keeps the health record
# (data/) and local secrets (.env) off the wire before anything is sent.
LEAKCHECK=$(mktemp -d) && trap 'rm -rf "$LEAKCHECK"' EXIT
# (-v file listing, not --out-format: macOS ships openrsync/rsync 2.6.9)
if rsync -anv "${EXCLUDES[@]}" "$SRC/" "$LEAKCHECK/" | grep -E '^(data/|\.env$)'; then
  die "rsync would upload data/ or .env — refusing (synthetic seed only on the demo box)"
fi
rsync -az --delete "${EXCLUDES[@]}" "$SRC/" "$SSH_HOST:$REMOTE_DIR/"

step "Generating demo compose overlay + Caddyfile"
TMPCFG=$(mktemp -d) && trap 'rm -rf "$LEAKCHECK" "$TMPCFG"' EXIT
# Overlay, not edits: docker-compose.yml hardcodes localhost URLs in
# environment:, which .env cannot override — and MEDPLUM_BASE_URL must equal
# the public URL or presigned storage links break. !override rebinds all
# published ports to loopback so only Caddy faces the internet.
cat > "$TMPCFG/docker-compose.demo.yml" <<EOF
# GENERATED by scripts/deploy_demo_vm.sh — re-running regenerates it.
services:
  medplum-server:
    ports: !override
      - '127.0.0.1:8103:8103'
    environment:
      MEDPLUM_BASE_URL: 'https://$DOMAIN/'
      MEDPLUM_APP_BASE_URL: 'https://$DOMAIN:9443/'
      MEDPLUM_STORAGE_BASE_URL: 'https://$DOMAIN/storage/'
      MEDPLUM_ALLOWED_ORIGINS: 'https://$DOMAIN:9443'
      # FRESH INSTALL EXCEPTION (mirrors infra/docker-compose.yml): the deploy
      # script exports HMD_DEMO_REGISTER=true only for the single 'up' that
      # precedes the first bootstrap, then re-ups -> back to 'false'.
      MEDPLUM_REGISTER_ENABLED: '\${HMD_DEMO_REGISTER:-false}'
  medplum-app:
    ports: !override
      - '127.0.0.1:3000:3000'
    environment:
      MEDPLUM_BASE_URL: 'https://$DOMAIN/'
  healmedaily-ai:
    ports: !override
      - '127.0.0.1:8000:8000'
    environment:
      AI_ALLOWED_ORIGINS: 'https://$DOMAIN:9443'
EOF
cat > "$TMPCFG/Caddyfile" <<EOF
# GENERATED by scripts/deploy_demo_vm.sh — demo review server for HealMeNow.
{
	email ${ACME_EMAIL:-admin@$DOMAIN}
}
# Root = the ONE URL the reviewer types into the iOS sign-in screen.
$DOMAIN {
	reverse_proxy 127.0.0.1:8103
	request_body {
		max_size 220MB
	}
}
# ai-service (optional in app Settings) — session-gated, AI providers unconfigured.
$DOMAIN:8443 {
	reverse_proxy 127.0.0.1:8000
}
# Medplum admin UI — for the owner, not the reviewer.
$DOMAIN:9443 {
	reverse_proxy 127.0.0.1:3000
}
EOF
scp -q "$TMPCFG/Caddyfile" "$SSH_HOST:/tmp/hmd-Caddyfile"
scp -q "$TMPCFG/docker-compose.demo.yml" "$SSH_HOST:/tmp/hmd-demo.yml"

step "Installing configs, .env, and Caddy (auto-TLS) on the VM"
vm "DOMAIN='$DOMAIN' REMOTE_DIR='$REMOTE_DIR' bash -s" <<'EOSSH'
set -euo pipefail
cd "$REMOTE_DIR"
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo -n"
install -m 0644 /tmp/hmd-demo.yml infra/docker-compose.demo.yml
$SUDO install -m 0644 /tmp/hmd-Caddyfile /etc/caddy/Caddyfile
$SUDO caddy validate --config /etc/caddy/Caddyfile >/dev/null
$SUDO systemctl enable --now caddy && $SUDO systemctl reload-or-restart caddy
# Some clouds (EC2 elastic IPs) can't hairpin to their own public IP; pin the
# domain to loopback ON THE VM so bootstrap/seed can use the real https URL.
grep -qE "^127\.0\.0\.1[[:space:]]+$DOMAIN" /etc/hosts || echo "127.0.0.1 $DOMAIN" | $SUDO tee -a /etc/hosts >/dev/null
[ -f .env ] || { cp .env.example .env; chmod 600 .env; echo "--- created .env from .env.example"; }
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
set_env MEDPLUM_BASE_URL "https://$DOMAIN/"
set_env VITE_MEDPLUM_BASE_URL "https://$DOMAIN/"
set_env VITE_AI_SERVICE_URL "https://$DOMAIN:8443/"
set_env AI_ALLOWED_ORIGINS "https://$DOMAIN:9443"
set_env AI_SERVICE_PUBLIC_URL ""     # push stays inert on the demo box
# The reviewer must land on the designed "configure a provider" states — a
# key smuggled into this .env would silently light AI up. Fail instead.
for k in AI_PROVIDER AI_MODEL ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY; do
  v=$(grep "^$k=" .env | cut -d= -f2-)
  [ -z "$v" ] || { echo "FATAL: $k is set in the VM .env — demo must ship with AI unconfigured"; exit 1; }
done
echo "--- .env ready; AI keys asserted empty"
EOSSH

step "Stack up + bootstrap + SYNTHETIC seed (first boot migrates — takes minutes)"
vm "DOMAIN='$DOMAIN' REMOTE_DIR='$REMOTE_DIR' bash -s" <<'EOSSH'
set -euo pipefail
cd "$REMOTE_DIR"
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo -n"
mkdir -p data/inbox data/secrets && chmod 700 data/secrets
# Minimal venv: bootstrap/seed only need httpx + dotenv (full ai-service deps
# live in the container image, not on the host).
[ -x ai-service/.venv/bin/python ] || { python3 -m venv ai-service/.venv; ai-service/.venv/bin/pip install -q httpx python-dotenv; }
# Registration window only while no owner exists (first run) — the flip-back
# 'up' below is what returns MEDPLUM_REGISTER_ENABLED to 'false'.
REG=false; grep -q '^HMD_ADMIN_PASSWORD=.' .env || REG=true
dc() { $SUDO env "HMD_DEMO_REGISTER=$REG" docker compose --env-file .env \
  -f infra/docker-compose.yml -f infra/docker-compose.app.yml -f infra/docker-compose.demo.yml "$@"; }
echo "--- docker compose up (registration window: $REG; web frontend skipped — iOS-only demo)"
dc up -d --build healmedaily-ai medplum-app
echo "--- waiting for medplum-server"
ok=false; for _ in $(seq 1 200); do
  if curl -sf http://127.0.0.1:8103/healthcheck >/dev/null; then ok=true; break; fi; sleep 3; done
$ok || { echo "FATAL: medplum-server never became healthy — docker compose logs medplum-server"; exit 1; }
echo "--- waiting for https://$DOMAIN (Caddy / Let's Encrypt issuance)"
ok=false; for _ in $(seq 1 60); do
  if curl -sf "https://$DOMAIN/healthcheck" >/dev/null; then ok=true; break; fi; sleep 3; done
$ok || { echo "FATAL: TLS endpoint unreachable — journalctl -u caddy"; exit 1; }
echo "--- bootstrap (owner + ClientApplication + least-privilege AccessPolicy)"
ai-service/.venv/bin/python scripts/bootstrap.py
if [ "$REG" = true ]; then REG=false; echo "--- closing registration window"; dc up -d healmedaily-ai medplum-app; fi
echo "--- seeding synthetic sample data (scripts/seed.py — the only data this box gets)"
ai-service/.venv/bin/python scripts/seed.py
EOSSH

step "Creating the demo reviewer account ($DEMO_EMAIL)"
vm "REMOTE_DIR='$REMOTE_DIR' DEMO_PASSWORD='${DEMO_PASSWORD:-}' bash -s" <<'EOSSH'
set -euo pipefail
cd "$REMOTE_DIR"
ai-service/.venv/bin/python - <<'PY'
import os, secrets, string, sys
sys.path.insert(0, "scripts")
from bootstrap import env, password_login, save          # shared .env + PKCE login helpers
from care_circle import Session, find_membership_by_email  # admin session + invite plumbing
email = "demo@healmenow.example"
pw = os.environ.get("DEMO_PASSWORD") or env("HMD_DEMO_PASSWORD") \
    or "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(20))
sess = Session()
if find_membership_by_email(sess, email) is None:
    # Practitioner profile, deliberately NO AccessPolicy binding: the reviewer
    # gets full project access so logging/check-ins actually work — acceptable
    # because everything on this box is synthetic seed data.
    sess.post(f"admin/projects/{sess.project_id}/invite", {
        "resourceType": "Practitioner", "firstName": "Demo", "lastName": "Reviewer",
        "email": email, "password": pw, "sendEmail": False,
    })
    print(f"[demo] invited {email}")
else:
    print(f"[demo] {email} already a member — keeping the existing account")
save("HMD_DEMO_EMAIL", email); save("HMD_DEMO_PASSWORD", pw)
if not password_login(env("MEDPLUM_BASE_URL"), email, pw):
    sys.exit("[demo] FATAL: demo login failed — stale password? Delete the demo "
             "user in the admin UI (ProjectMembership) and re-run this script.")
print("[demo] demo sign-in verified against the public URL")
PY
EOSSH

step "Verifying from this Mac"
curl -sf "https://$DOMAIN/healthcheck" >/dev/null && echo "    FHIR server OK   https://$DOMAIN/"
curl -sf "https://$DOMAIN:8443/health" >/dev/null && echo "    ai-service OK    https://$DOMAIN:8443/"
curl -sfo /dev/null "https://$DOMAIN:9443/" && echo "    admin UI OK      https://$DOMAIN:9443/"
DEMO_PW=$(vm "grep '^HMD_DEMO_PASSWORD=' '$REMOTE_DIR/.env' | cut -d= -f2-")

cat <<SUMMARY

============================================================
 HealMeNow demo review server is up
------------------------------------------------------------
 iOS server URL : https://$DOMAIN/
 ai-service URL : https://$DOMAIN:8443/   (optional, app Settings)
 Admin UI       : https://$DOMAIN:9443/   (owner creds: HMD_ADMIN_* in $REMOTE_DIR/.env on the VM)
 Demo account   : $DEMO_EMAIL / $DEMO_PW

 Paste into APPSTORE-LISTING.md "Review notes":
   Server URL (enter on the sign-in screen): https://$DOMAIN/
   Email: $DEMO_EMAIL    Password: $DEMO_PW

 Not done here (deliberate): make rotate-superadmin (factory
 super-admin still active), make bots, DEPLOYMENT.md 4.2 hardening.
============================================================
SUMMARY
