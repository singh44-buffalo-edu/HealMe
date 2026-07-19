# HealMeDaily — connectors design (Claude / ChatGPT read your record)

> **Status: design proposal, awaiting owner sign-off. No code, no exposure exists yet.**
> This is the "design-first" deliverable for the request *"connect with the Claude / ChatGPT app
> through connectors."* It exists so the privacy cost is fully visible **before** anything is built.

Read [DEPLOYMENT.md](./DEPLOYMENT.md) and [CLAUDE.md](./CLAUDE.md) §6 first — the trade-off here is
the same one those documents guard, taken to its limit.

---

## 1. What is actually being asked

There are two opposite directions of "AI", and this document is about the second one:

| | Direction | Who is the client | Where your PHI goes | Status |
| --- | --- | --- | --- | --- |
| **BYOK** (already ~built) | HealMeDaily → your LLM | HealMeDaily | To **your own** LLM account, on demand, disclosed + AuditEvent-logged | Server-managed key UI landing now |
| **Connectors** (this doc) | The Claude / ChatGPT **app** → HealMeDaily | Anthropic / OpenAI | Into **their** cloud, on every question you ask them | Not built |

A connector makes HealMeDaily an **MCP server** (Model Context Protocol). You add it once inside the
Claude app / claude.ai / ChatGPT; from then on you can ask *them* — "what's my adherence this week?",
"list my active meds" — and they call tools on your record to answer.

---

## 2. The privacy line this crosses — read this before deciding

The core promise of this app is *"your record never leaves your hardware."* A connector is the one
feature that deliberately breaks it. Be clear-eyed about exactly how:

1. **Your PHI enters Anthropic's / OpenAI's cloud.** When Claude/ChatGPT calls a tool and reads the
   result, that record data is now in their model context — subject to their terms, their retention,
   their logging. This is true **even if the MCP server runs on your own machine** (see §4): the
   *server* can stay local, but the *model* runs in their cloud, so the moment the model uses a tool
   result, the data has left your hardware.
2. **The non-diagnostic guarantee moves out of our control.** In-app, every AI summary carries the
   "not medical advice" disclaimer and organizes-never-diagnoses framing (CLAUDE.md §6). Once Claude/
   ChatGPT is interpreting your record, *their* output is not bound by our guardrails. We can label the
   connector and every tool description, but we cannot stop the external model from saying something
   diagnostic. This is a real regression of the app's safety posture and must be disclosed to you.
3. **Web connectors force public exposure.** claude.ai and ChatGPT run in the browser/their cloud and
   **cannot reach a Tailscale tailnet or a home LAN.** A web connector therefore requires a
   **publicly reachable HTTPS endpoint** — which pushes you off the recommended home+Tailscale posture
   (DEPLOYMENT.md Option A) and onto a public cloud VM (Option B), with all its hardening burden.

None of this is a reason you *can't* do it — it's your record and your call. It is the reason it needs
explicit, informed sign-off rather than being shipped by default.

---

## 3. Two flavors of connector (pick per-app)

MCP is the common protocol; the exposure differs sharply by which app you connect from.

### 3a. Local-app connector — Claude Desktop (lowest exposure)
Claude Desktop can talk to a **local** MCP server (stdio, or `http://localhost`). The MCP server runs
on the same machine as your stack and reaches Medplum over the LAN/loopback.
- ✅ **No public endpoint** — nothing is exposed to the internet; works with the home+Tailscale posture.
- ✅ Server stays on your hardware.
- ⚠️ PHI still egresses to Anthropic's cloud once the Claude Desktop model reads a tool result (§2.1).
- ❌ Does not help the **phone** Claude app or ChatGPT (those are cloud clients).

### 3b. Web/cloud connector — claude.ai, Claude mobile, ChatGPT (highest exposure)
These add a connector by **URL** and run an OAuth flow against a public HTTPS MCP endpoint.
- ✅ Works from any device, including the phone, without our app.
- ❌ **Requires a public HTTPS MCP server** → cloud-VM deployment (DEPLOYMENT.md Option B), TLS, and a
  hardened, internet-facing surface holding a token that can read your whole record.
- ⚠️ Same PHI-to-cloud egress as 3a, plus the public attack surface.

> Recommendation: if connectors happen at all, **start with 3a (Claude Desktop, local)** — same model
> access, none of the public-exposure risk — and only add 3b if you specifically need it from the phone
> or from ChatGPT.

---

## 4. Architecture

```
  Claude app / claude.ai / ChatGPT
            │  MCP (Streamable HTTP or stdio) + OAuth2 bearer
            ▼
  ┌─────────────────────────────────────────────────────────┐
  │  HealMeDaily MCP server (NEW)                             │
  │   • OAuth2 resource server — OWNER-ONLY                   │
  │   • Read-only, scoped, non-diagnostic tools              │
  │   • Boundary-ledger AuditEvent BEFORE returning each tool │
  │   • Data minimization (summaries, not raw dumps)          │
  └───────────────┬──────────────────────────────────────────┘
                  │  FHIR REST (owner's Patient only)
                  ▼
        Medplum CDR  (your record)
```

- **New component**, sibling to the ai-service (Python/FastAPI is the natural fit; MCP has a Python
  SDK). It authenticates to Medplum with a **least-privilege, read-only** ClientApplication/AccessPolicy
  scoped to the one Patient — never the full-access token the ai-service holds.
- **Never a write path.** No tool logs a dose, edits a med, or triggers the dispenser. Writing from an
  external LLM would violate "never act without in-the-moment in-app confirmation" and the non-diagnostic
  rule. Connectors are **read-only, forever.**

### Auth (owner-only)
- The MCP server is an OAuth2 resource server. Simplest correct design: **delegate to Medplum's own
  OAuth** (Medplum is a SMART/OAuth2 server) so the connector's token maps to the owner's identity, and
  reuse the `AI_OWNER_PROFILES` allowlist idea — only the owner's profile is authorized; anyone else
  gets 403.
- Tokens are scoped read-only and to the single Patient. Short-lived; refresh via the standard flow.
- For 3b, the OAuth endpoints are part of the public surface — treat them as security-critical.

### Tool surface (all read-only, all non-diagnostic, all minimized)
Curated, not a generic "run any FHIR query" bridge — that would leak the whole record in one call.
Candidate tools:
- `list_active_medications` → name, SIG text, life-critical flag. No raw resource dump.
- `adherence_summary(window_days)` → per-med taken/skipped/missed counts + %; critical meds first.
- `recent_vitals(kind, window_days)` → measured values only (never AI-derived), with units + timestamps.
- `list_conditions` / `list_allergies` → problem/allergy lists (verified codes + text).
- `recent_labs(window_days)` → DiagnosticReport/Observation summaries with reference ranges.
- `find_records(query)` → bounded search over DocumentReference titles/dates (not contents by default).

Each tool description carries the "organizes, does not diagnose; not medical advice" framing, and each
call writes a **boundary-ledger AuditEvent** naming the recipient (Anthropic/OpenAI) **before** the data
is returned — identical to the cloud-AI egress rule, so "who saw my record lately" on the History page
stays truthful.

### Data minimization
Tools return **summaries and named fields**, never `Bundle` dumps or `Binary` contents. A question about
adherence returns adherence numbers, not the raw MedicationAdministration history. This bounds how much
PHI any single query ships to the external cloud.

---

## 5. What this is NOT

- **Not the BYOK feature.** BYOK (your key, in-app, server-side keystore) is landing separately and keeps
  the record on your hardware. Connectors are the opposite direction.
- **Not a write/agent surface.** No dose logging, no med edits, no dispenser control from Claude/ChatGPT.
- **Not covered by our disclaimers.** The external model's output is outside our safety guardrails.

---

## 6. Decision points (for you)

1. **Do connectors happen at all?** They are the single largest privacy crossing in the app.
2. **If yes — which flavor first?** 3a Claude-Desktop-local (recommended: no public exposure) vs 3b
   web/cloud (phone + ChatGPT, but public HTTPS + cloud-VM required).
3. **Deployment consequence acknowledged?** 3b means moving to DEPLOYMENT.md Option B (public VM), away
   from home+Tailscale.
4. **Tool scope** — the read-only list in §4, or narrower.

## 7. If approved — build phases

1. **MCP server skeleton** (local/stdio, Claude Desktop): read-only Medplum client (least-privilege
   AccessPolicy), 2–3 tools (`list_active_medications`, `adherence_summary`), owner-only OAuth, boundary
   AuditEvent per call. Prove it in Claude Desktop against the LAN — zero public exposure.
2. **Full read-only tool set** + data-minimization review + History-page surfacing of connector egress.
3. **Web/cloud exposure** (only if 3b chosen): public HTTPS via the Option-B Caddy stack, OAuth hardening,
   ChatGPT connector parity, rate limiting.

Nothing in phase 1 exposes anything publicly, so it is the safe place to start once you decide.
