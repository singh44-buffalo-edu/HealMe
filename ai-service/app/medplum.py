"""Minimal Medplum FHIR client over OAuth2 client credentials.

The single door to the CDR for the whole ai-service: every other module
(health_review, ingest, importers, assistant, ai_settings, export, watcher)
imports the `medplum` singleton defined at the bottom. It speaks plain FHIR
REST to medplum-server (:8103, MEDPLUM_BASE_URL) authenticating with the
ClientApplication id/secret from .env — see CLAUDE.md §5 "Auth (Python
service)". All clinical data lives in the Medplum CDR; there is no side
database (CLAUDE.md §2).

Behaviors an external developer must know before touching this file:
- Token cache: one bearer token shared across threads (lock-guarded),
  refreshed 60 s before its advertised expiry, and force-refreshed once when
  any request comes back 401 (`request`). Callers never handle auth.
- `read_attachment` works around a Medplum quirk: on read, Attachment.url is
  rewritten into a presigned /storage/{binaryId}/{versionId}?... URL whose
  signature binds to the server's *public* host — unusable from inside the
  Docker compose network. We extract the binary id and re-read it through
  the authenticated FHIR endpoint instead (CLAUDE.md §9).
- `post_bundle` guards against partial transaction commits: on 5.1.26 a
  bundle entry can fail with a per-entry 400 while the *other entries still
  commit* (CLAUDE.md §9). Any non-2xx entry status is raised as a hard error
  so callers notice; combined with the stable identifiers + If-None-Exist
  convention (CLAUDE.md §6) a retry then converges instead of duplicating.
"""

from __future__ import annotations

import threading
import time
from typing import Any

import httpx

from .config import settings


class MedplumError(RuntimeError):
    """Any Medplum-side failure: token grant, HTTP >= 400, or a failing bundle entry."""


class MedplumFhirClient:
    """Thread-safe synchronous FHIR REST client with cached client-credentials auth.

    One long-lived instance (`medplum` below) is shared by all endpoints and the
    watcher thread; httpx.Client pools the connections."""

    def __init__(self) -> None:
        base = settings.medplum_base_url
        self.base_url = base if base.endswith("/") else base + "/"
        self.fhir_url = self.base_url + "fhir/R4/"
        self._http = httpx.Client(timeout=30.0)
        self._token: str | None = None
        self._expires_at = 0.0
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        """True when ClientApplication credentials exist in .env. The app must boot
        (and /health must answer) without them — callers check before any request."""
        return bool(settings.medplum_client_id and settings.medplum_client_secret)

    def _fetch_token(self) -> None:
        """OAuth2 client-credentials grant against {base}/oauth2/token (CLAUDE.md §5).
        Caller must hold self._lock. Raises MedplumError on any non-200."""
        resp = self._http.post(
            self.base_url + "oauth2/token",
            data={
                "grant_type": "client_credentials",
                "client_id": settings.medplum_client_id,
                "client_secret": settings.medplum_client_secret,
            },
        )
        if resp.status_code != 200:
            raise MedplumError(f"token request failed: {resp.status_code} {resp.text[:300]}")
        payload = resp.json()
        self._token = payload["access_token"]
        # Refresh 60 s before the advertised expiry (default 3600 s) so a token
        # never dies mid-request on a slow OCR/model round trip.
        self._expires_at = time.time() + int(payload.get("expires_in", 3600)) - 60

    def _auth_header(self) -> dict[str, str]:
        """Bearer header from the cache, fetching/refreshing under the lock when
        the token is absent or within the 60 s expiry margin."""
        with self._lock:
            if not self._token or time.time() >= self._expires_at:
                self._fetch_token()
            return {"Authorization": f"Bearer {self._token}"}

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        """Authenticated request against the FHIR R4 base (relative `path`) or an
        absolute URL. On a 401 the cached token is dropped and the request is
        retried exactly once with a fresh token (expired/rotated credentials);
        a second 401 is returned to the caller. Never raises on HTTP status —
        the typed wrappers below (get/create/update/...) do that."""
        if not self.configured:
            raise MedplumError("Medplum client credentials are not configured (.env)")
        url = path if path.startswith("http") else self.fhir_url + path.lstrip("/")
        headers = {**self._auth_header(), "Content-Type": "application/fhir+json", **kwargs.pop("headers", {})}
        resp = self._http.request(method, url, headers=headers, **kwargs)
        if resp.status_code == 401:
            # Server rejected the cached token (revoked/clock skew): invalidate,
            # re-auth, retry once. All verbs used here are safe to replay —
            # writes carry conditional headers per the idempotency convention.
            with self._lock:
                self._token = None
            headers.update(self._auth_header())
            resp = self._http.request(method, url, headers=headers, **kwargs)
        return resp

    def get(self, path: str, **kwargs: Any) -> dict[str, Any]:
        """GET a FHIR path (e.g. "Patient/123") and return the parsed resource.
        Raises MedplumError on any HTTP >= 400."""
        resp = self.request("GET", path, **kwargs)
        if resp.status_code >= 400:
            raise MedplumError(f"GET {path}: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def search(self, resource_type: str, params: dict[str, Any]) -> dict[str, Any]:
        """FHIR search returning the raw searchset Bundle. Medplum defaults:
        _count=20 (max 1000), _total=none — ask _total=accurate when you need
        Bundle.total. Always filter server-side (CLAUDE.md §5 "Search")."""
        return self.get(resource_type, params=params)

    def search_resources(self, resource_type: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        """Like `search` but unwraps entries to plain resources. Single page only —
        pass a _count high enough for the expected volume (single-user data)."""
        bundle = self.search(resource_type, params)
        return [e["resource"] for e in bundle.get("entry", [])]

    def create(self, resource: dict[str, Any]) -> dict[str, Any]:
        """POST one resource; returns it with server-assigned id/meta. NOT
        idempotent by itself — callers that can be retried/replayed must pass an
        If-None-Exist header via `request` or go through a transaction bundle."""
        resp = self.request("POST", resource["resourceType"], json=resource)
        if resp.status_code >= 400:
            raise MedplumError(f"create {resource['resourceType']}: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def update(self, resource: dict[str, Any]) -> dict[str, Any]:
        """PUT a full resource by its id. Last-write-wins — for read-modify-write
        races (e.g. cartridge decrements) callers add an ifMatch version check."""
        path = f"{resource['resourceType']}/{resource['id']}"
        resp = self.request("PUT", path, json=resource)
        if resp.status_code >= 400:
            raise MedplumError(f"update {path}: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def create_binary(self, data: bytes, content_type: str) -> dict[str, Any]:
        """Upload raw bytes as a Binary (documents, proposal payloads, PDFs).
        Referenced from Attachment.url as "Binary/{id}" — never embedded as
        Attachment.data (FHIR-MAPPING §6)."""
        resp = self.request("POST", "Binary", content=data, headers={"Content-Type": content_type})
        if resp.status_code >= 400:
            raise MedplumError(f"binary create: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def read_binary(self, binary_id: str) -> bytes:
        """Raw bytes of a Binary. Accept: */* makes Medplum stream the stored
        content instead of a FHIR JSON wrapper."""
        resp = self.request("GET", f"Binary/{binary_id}", headers={"Accept": "*/*"})
        if resp.status_code >= 400:
            raise MedplumError(f"binary read: {resp.status_code} {resp.text[:300]}")
        return resp.content

    def read_attachment(self, url: str) -> bytes:
        """Fetch an Attachment.url as returned by Medplum. On read, Medplum
        rewrites Binary/{id} references into presigned absolute
        /storage/{binaryId}/{versionId}?... URLs whose signature is bound to
        the server's public host — unusable from inside the compose network.
        Extract the binary id and read it through the authenticated FHIR
        endpoint instead (Accept */* streams the raw content)."""
        if url.startswith("http"):
            from urllib.parse import urlparse

            parts = urlparse(url).path.strip("/").split("/")
            if len(parts) >= 2 and parts[0] == "storage":
                return self.read_binary(parts[1])
            raise MedplumError(f"unrecognized attachment url shape: {url[:120]}")
        return self.read_binary(url.split("/")[-1])

    def post_bundle(self, bundle: dict[str, Any]) -> dict[str, Any]:
        """POST a transaction Bundle to the FHIR base — the required vehicle for
        multi-resource writes (CLAUDE.md §6). Verifies EVERY entry's
        response.status because Medplum transactions are not all-or-nothing on
        validation errors: valid entries commit while an invalid one 400s,
        leaving intra-bundle references dangling. Raising here means callers
        must retry with stable identifiers (ifNoneExist) to converge safely."""
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
            # Medplum commits valid entries despite per-entry errors (see CLAUDE.md) —
            # treat any per-entry failure as a hard error so callers notice.
            raise MedplumError(f"bundle had failing entries: {bad[:3]}")
        return result


# Module-level singleton — the one client instance the whole service shares.
medplum = MedplumFhirClient()
