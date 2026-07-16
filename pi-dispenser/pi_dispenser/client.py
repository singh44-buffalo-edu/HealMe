"""Medplum FHIR client over OAuth2 client credentials — dispenser edition.

Pattern copied from ai-service/app/medplum.py (token cache + 401 retry-once);
packages never import across package boundaries in this repo. The dispenser
authenticates as its own ClientApplication, scoped by AccessPolicy to dose
events only (FHIR-MAPPING.md §9), LAN only.

Sits below events.MedplumSink (the only writer) and schedule.fetch_regimen
(the only reader). Everything above works with plain dicts — no fhirtypes
here, the Pi keeps dependencies to stdlib + httpx (pyproject.toml).

Environment:
    DISPENSER_MEDPLUM_BASE_URL       default http://localhost:8103/
    DISPENSER_MEDPLUM_CLIENT_ID
    DISPENSER_MEDPLUM_CLIENT_SECRET
    DISPENSER_MEDPLUM_PATIENT_ID     the one Patient (the owner)

Key invariants: writes go through create_if_none_exist / update_if_match /
post_bundle only — never a bare POST/PUT — so every retry path stays
idempotent (CLAUDE.md §6). post_bundle hard-fails on ANY per-entry error
because Medplum transactions are not all-or-nothing on validation errors
(CLAUDE.md §9 gotcha).
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any

import httpx


class MedplumError(RuntimeError):
    """Any Medplum failure: token grant, HTTP >= 400, or a partially-failed
    transaction bundle. Message carries status + the first 300 chars of the
    body for journalctl-friendly one-line diagnostics."""

    pass


class DispenserMedplumClient:
    """Thin Medplum REST client with a cached OAuth2 token.

    Construction never touches the network; explicit args override the
    DISPENSER_MEDPLUM_* env (tests pass args, the Pi uses env from the
    systemd EnvironmentFile). Safe to construct unconfigured — `configured`
    tells callers (cli.cmd_sim) whether to write for real or dry-run.
    """

    def __init__(
        self,
        base_url: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        patient_id: str | None = None,
    ) -> None:
        base = base_url or os.environ.get("DISPENSER_MEDPLUM_BASE_URL", "http://localhost:8103/")
        self.base_url = base if base.endswith("/") else base + "/"
        self.fhir_url = self.base_url + "fhir/R4/"
        self.client_id = client_id or os.environ.get("DISPENSER_MEDPLUM_CLIENT_ID", "")
        self.client_secret = client_secret or os.environ.get("DISPENSER_MEDPLUM_CLIENT_SECRET", "")
        self.patient_id = patient_id or os.environ.get("DISPENSER_MEDPLUM_PATIENT_ID", "")
        self._http = httpx.Client(timeout=30.0)
        self._token: str | None = None
        self._expires_at = 0.0
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        """True when credentials exist; does NOT prove they work (that shows
        up as a MedplumError on the first request)."""
        return bool(self.client_id and self.client_secret)

    def _fetch_token(self) -> None:
        # OAuth2 client-credentials grant (CLAUDE.md §5 "Auth"). The 60s
        # early-expiry margin avoids using a token that dies mid-request.
        resp = self._http.post(
            self.base_url + "oauth2/token",
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
        )
        if resp.status_code != 200:
            raise MedplumError(f"token request failed: {resp.status_code} {resp.text[:300]}")
        payload = resp.json()
        self._token = payload["access_token"]
        self._expires_at = time.time() + int(payload.get("expires_in", 3600)) - 60

    def _auth_header(self) -> dict[str, str]:
        with self._lock:
            if not self._token or time.time() >= self._expires_at:
                self._fetch_token()
            return {"Authorization": f"Bearer {self._token}"}

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        """Authenticated FHIR request. `path` is relative to fhir/R4/ unless
        absolute. Retries exactly once on 401 with a fresh token (expired or
        revoked mid-flight); all other statuses are returned for the caller
        to judge — this layer never raises on HTTP errors itself."""
        if not self.configured:
            raise MedplumError("dispenser Medplum credentials are not configured (DISPENSER_MEDPLUM_* env)")
        url = path if path.startswith("http") else self.fhir_url + path.lstrip("/")
        headers = {**self._auth_header(), "Content-Type": "application/fhir+json", **kwargs.pop("headers", {})}
        resp = self._http.request(method, url, headers=headers, **kwargs)
        if resp.status_code == 401:
            with self._lock:
                self._token = None
            headers.update(self._auth_header())
            resp = self._http.request(method, url, headers=headers, **kwargs)
        return resp

    def get(self, path: str, **kwargs: Any) -> dict[str, Any]:
        """GET a resource (or search) and return the parsed JSON body.
        Raises MedplumError on any >= 400."""
        resp = self.request("GET", path, **kwargs)
        if resp.status_code >= 400:
            raise MedplumError(f"GET {path}: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def search_resources(self, resource_type: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        """One page of search results as plain resource dicts. Callers always
        pass typed params + `_count` (server-side filtering, CLAUDE.md §5);
        the dispenser's result sets are small so no pagination here."""
        bundle = self.get(resource_type, params=params)
        return [e["resource"] for e in bundle.get("entry", [])]

    def create_if_none_exist(self, resource: dict[str, Any], query: str) -> dict[str, Any]:
        """Conditional create: identifier-stable retries never duplicate.

        `query` is the If-None-Exist search (e.g. "identifier=sys|value") —
        when it matches, Medplum returns the existing resource instead of
        creating a second one, which is what makes replays safe."""
        resp = self.request(
            "POST", resource["resourceType"], json=resource, headers={"If-None-Exist": query}
        )
        if resp.status_code >= 400:
            raise MedplumError(f"create {resource['resourceType']}: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def update_if_match(self, resource: dict[str, Any], version_id: str | None) -> dict[str, Any]:
        """Version-checked update for read-modify-write (skipped -> taken).

        `version_id` is the meta.versionId read alongside the existing
        resource; a concurrent edit (e.g. the owner in the app) makes the
        PUT fail with 412 instead of silently clobbering their change."""
        path = f"{resource['resourceType']}/{resource['id']}"
        headers = {"If-Match": f'W/"{version_id}"'} if version_id else {}
        resp = self.request("PUT", path, json=resource, headers=headers)
        if resp.status_code >= 400:
            raise MedplumError(f"update {path}: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def post_bundle(self, bundle: dict[str, Any]) -> dict[str, Any]:
        """POST a transaction Bundle to the FHIR base and verify EVERY entry
        succeeded, not just the outer 200 (see module docstring)."""
        resp = self.request("POST", self.base_url + "fhir/R4", json=bundle)
        if resp.status_code >= 400:
            raise MedplumError(f"bundle POST: {resp.status_code} {resp.text[:300]}")
        result = resp.json()
        bad = [
            e.get("response", {})
            for e in result.get("entry", [])
            if not e.get("response", {}).get("status", "").startswith(("200", "201"))
        ]
        if bad:
            # Medplum commits valid entries despite per-entry errors (CLAUDE.md §9) —
            # any per-entry failure is a hard error so callers notice.
            raise MedplumError(f"bundle had failing entries: {bad[:3]}")
        return result
