"""Minimal Medplum FHIR client over OAuth2 client credentials.

Token is cached and refreshed on expiry or on a 401 (once per request).
All clinical data lives in the Medplum CDR — this client is the only door.
"""

from __future__ import annotations

import threading
import time
from typing import Any

import httpx

from .config import settings


class MedplumError(RuntimeError):
    pass


class MedplumFhirClient:
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
        return bool(settings.medplum_client_id and settings.medplum_client_secret)

    def _fetch_token(self) -> None:
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
        self._expires_at = time.time() + int(payload.get("expires_in", 3600)) - 60

    def _auth_header(self) -> dict[str, str]:
        with self._lock:
            if not self._token or time.time() >= self._expires_at:
                self._fetch_token()
            return {"Authorization": f"Bearer {self._token}"}

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        if not self.configured:
            raise MedplumError("Medplum client credentials are not configured (.env)")
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
        resp = self.request("GET", path, **kwargs)
        if resp.status_code >= 400:
            raise MedplumError(f"GET {path}: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def search(self, resource_type: str, params: dict[str, Any]) -> dict[str, Any]:
        return self.get(resource_type, params=params)

    def search_resources(self, resource_type: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        bundle = self.search(resource_type, params)
        return [e["resource"] for e in bundle.get("entry", [])]

    def create(self, resource: dict[str, Any]) -> dict[str, Any]:
        resp = self.request("POST", resource["resourceType"], json=resource)
        if resp.status_code >= 400:
            raise MedplumError(f"create {resource['resourceType']}: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def update(self, resource: dict[str, Any]) -> dict[str, Any]:
        path = f"{resource['resourceType']}/{resource['id']}"
        resp = self.request("PUT", path, json=resource)
        if resp.status_code >= 400:
            raise MedplumError(f"update {path}: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def create_binary(self, data: bytes, content_type: str) -> dict[str, Any]:
        resp = self.request("POST", "Binary", content=data, headers={"Content-Type": content_type})
        if resp.status_code >= 400:
            raise MedplumError(f"binary create: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def read_binary(self, binary_id: str) -> bytes:
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


medplum = MedplumFhirClient()
