#!/usr/bin/env python
"""Rotate the Medplum instance super-admin password (Phase 9 hardening).

Medplum seeds every fresh self-hosted instance with the well-known super
admin `admin@example.com` / `medplum_admin`. The compose file publishes :8103
and :3000 on the host, so anyone on the LAN holding that default can read and
write the ENTIRE CDR, bypassing every AccessPolicy in the project. This
script closes that hole — run it deliberately via `make rotate-superadmin`
(owner-initiated only; never part of bootstrap/seed automation):

  1. log in as the current super admin (HMD_SUPERADMIN_EMAIL/PASSWORD from
     .env — the same credentials deploy_bots.py uses for feature flips)
  2. generate a strong random password
  3. `POST admin/super/setpassword {email, password}` — the endpoint behind
     the Super Admin panel's "Set Password" form, verified against the pinned
     medplum-server v5.1.26 source (packages/server/src/admin/super.ts:
     requireSuperAdmin, password min 8 chars). Re-verify the endpoint if the
     server image pin in infra/docker-compose.yml is ever bumped.
  4. persist the new value into .env (HMD_SUPERADMIN_PASSWORD, via the same
     set_key-backed save() bootstrap uses) and verify a fresh login with it

`--dry-run` checks the current credentials and prints the plan without
changing anything.

Failure-window note (mirrors bootstrap.py's persist-first rationale): the
new password is written to .env BEFORE the server-side change, so a crash
between the two steps never strands a password nobody knows. If the server
call then fails, the previous value is restored to .env. If a hard kill
lands exactly between save and server call, .env holds the new value while
the server still has the old one — put the previous value back in .env and
re-run (the login-failure message below says the same).
"""

from __future__ import annotations

import argparse
import secrets
import string
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))
from bootstrap import env, password_login, save  # noqa: E402

# Server-side minimum is 8 chars (v5.1.26 validator); go long — this value
# is only ever typed by scripts reading .env, never by a human.
PASSWORD_LENGTH = 32


def log(msg: str) -> None:
    print(f"[rotate-superadmin] {msg}")


def die(msg: str) -> None:
    print(f"[rotate-superadmin] FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def generate_password() -> str:
    """Alphanumeric secret (same alphabet as bootstrap's owner password —
    quote-safe in .env with set_key's quote_mode='never')."""
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(PASSWORD_LENGTH))


def set_server_password(base: str, token: str, email: str, new_password: str) -> None:
    """The documented super-admin password-set call (module docstring step 3)."""
    resp = httpx.post(
        base + "admin/super/setpassword",
        json={"email": email, "password": new_password},
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"{resp.status_code} {resp.text[:300]}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Rotate the Medplum super-admin password and update .env"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="verify the current credentials and print the plan; change nothing",
    )
    args = parser.parse_args()

    base = env("MEDPLUM_BASE_URL", "http://localhost:8103/")
    if not base.endswith("/"):
        base += "/"
    email = env("HMD_SUPERADMIN_EMAIL", "admin@example.com")
    old_password = env("HMD_SUPERADMIN_PASSWORD", "medplum_admin")

    token = password_login(base, email, old_password)
    if not token:
        die(
            "super admin login failed — check HMD_SUPERADMIN_EMAIL/PASSWORD in .env and that the stack is up "
            "(`make up`). If a previous rotation was interrupted the server may still hold the prior password: "
            "restore it in .env and re-run."
        )
    log(f"logged in as super admin {email}")
    if old_password == "medplum_admin":
        log("current password is the Medplum factory default — rotation is overdue")

    if args.dry_run:
        log("dry run — no changes made. A real run would:")
        log(
            f"  1. write a freshly generated {PASSWORD_LENGTH}-char password to .env (HMD_SUPERADMIN_PASSWORD)"
        )
        log(f"  2. POST admin/super/setpassword for {email} at {base}")
        log("  3. verify a fresh login with the new password")
        return

    new_password = generate_password()
    # Persist BEFORE the server call (docstring failure-window note); restore
    # the old value if the server rejects the change.
    save("HMD_SUPERADMIN_PASSWORD", new_password)
    try:
        set_server_password(base, token, email, new_password)
    except (RuntimeError, httpx.HTTPError) as exc:
        save("HMD_SUPERADMIN_PASSWORD", old_password)
        die(f"setpassword failed — .env restored to the previous value: {exc}")

    if not password_login(base, email, new_password):
        die(
            "server accepted the change but a login with the new password failed — investigate before "
            "trusting the credentials (the new value IS stored in .env as HMD_SUPERADMIN_PASSWORD)"
        )
    log(
        "rotated: server updated, HMD_SUPERADMIN_PASSWORD in .env updated, fresh login verified"
    )
    log(
        "the factory default no longer works; deploy_bots.py feature flips keep reading .env as before"
    )


if __name__ == "__main__":
    main()
