# MCP Server

TypeScript server exposing TETA+PI to AI agents via the Model Context Protocol.
Source: `mcp/src/index.ts` (tools + HTTP bootstrap) + `mcp/src/client.ts` (API
client, 15s timeout per call). Tool handlers are stateless — every call hits
`api.tetapi.dev` over HTTP. Deployed as systemd `tetapi-mcp` on port 3002,
public at `mcp.tetapi.dev`. **Version 1.3.1.**

## Transport & manifest
- HTTP + SSE via `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport`,
  **one transport + `McpServer` per client session** (`mcp/src/index.ts`,
  `sessions: Map<string, StreamableHTTPServerTransport>` keyed by the
  `Mcp-Session-Id` the SDK assigns on `initialize`). Do not go back to a single
  module-level transport — see 2.5 hardening below for why.
- `GET /.well-known/mcp` → server manifest (name, version, tool list).
- `GET /health` → status.
- CORS enabled on every route (`Access-Control-Allow-Origin: *` + preflight
  `OPTIONS` handling) so browser-based MCP clients (Inspector web UI, etc.)
  can connect directly.
- Any path other than `/health`, `/.well-known/mcp`, `/mcp` returns a plain
  404 instead of falling into the MCP transport.
- `TETA_PI_API_URL` env points at the API base (`…/api/v1`).

## 2.5 hardening (2026-07-13)
Live E2E testing from real clients (`claude mcp add --transport http`, the
official `@modelcontextprotocol/inspector --cli`, and raw JSON-RPC over curl)
found the deployed server unusable for more than one client at a time:

- **Fixed — single shared transport.** The old bootstrap created exactly one
  `StreamableHTTPServerTransport` at module scope for the whole process and
  called `server.connect(transport)` once. Since a stateful transport only
  supports one active session, the **second** client to connect (a second
  Claude Code window, MCP Inspector while Claude Code was already connected,
  etc.) got `"Server already initialized"` and was locked out until the
  process restarted. Reproduced with `claude mcp add` failing outright while
  a curl session was still open, and with `npx @modelcontextprotocol/inspector
  --cli` failing the same way on first try. Fixed by keying a
  `Map<sessionId, transport>` off `Mcp-Session-Id`, creating a fresh
  `McpServer` + transport per session (official SDK stateful-HTTP pattern),
  and returning a clean `400 "No valid session ID provided"` for unknown/stale
  session ids instead of corrupting shared state.
- **Fixed — no CORS.** `OPTIONS /mcp` returned a bare `405`, and no response
  carried `Access-Control-Allow-*` headers. Any browser-based client would
  fail preflight. Added CORS headers to every response + explicit `OPTIONS`
  handling.
- **Fixed — unscoped routing.** Any path/method not matching `/health` or
  `/.well-known/mcp` fell through to `transport.handleRequest`, so e.g.
  `POST /whatever` was silently processed as if it were `/mcp`. Now scoped:
  only `/mcp` reaches the transport, everything else is a real `404`.
- **Fixed — no request timeout.** `client.ts::apiFetch` had no timeout; a
  hung `api.tetapi.dev` call would hang the tool call (and the client's
  request) indefinitely. Added a 15s `AbortController` timeout.
- **Found, not fixed here (out of scope for `mcp/src/*`) — backend 500 on
  `/businesses/{id}/preview`.** `teta_verify_entity`, `teta_get_profile`, and
  `teta_verify_claim` all call this endpoint and all three currently return
  `API 500: Internal Server Error` for real entities in production (confirmed
  live, and reproduced with a direct `curl` to `api.tetapi.dev`, so it's a
  backend bug, not an MCP-layer one). `teta_get_proof`, `teta_search`,
  `teta_verify_endpoint`, and `teta_resolve_intent` all work correctly. See
  `docs/known-issues.md` — this blocks 3 of 7 tools and needs a backend
  session.
- Version bumped **1.3.0 → 1.3.1** (bootstrap-only fix, no tool schema or
  behaviour change) in `mcp/package.json`, `mcp/src/index.ts`
  (`SERVER_VERSION`), the `/.well-known/mcp` manifest, and both `agent.json`
  files.

## Tools (7)
| Tool | Purpose | Backend |
|---|---|---|
| `teta_search` | search verified entities by name/type/country | `/search` |
| `teta_verify_entity` | full verified profile + registry attestation | `/businesses/{id}/preview` |
| `teta_verify_endpoint` | confirm a domain/endpoint belongs to a verified entity | `/verify-endpoint` |
| `teta_get_proof` | raw cryptographic proof (registry hash, C2PA, BTC OTS) **+ proof depth** (`ots_status`, `btc_timestamp_depth`, `c2pa_chain_length`, `event_count`) so agents set their own trust threshold | `/businesses/{id}/proof` |
| `teta_resolve_intent` | **flagship** — TWIRA-ranked routing; full T/I/P breakdown, `first_verified_at`, `proof_url`; filters `entity_types` + `min_trust` | `/resolve-intent` |
| `teta_get_profile` | public profile + public blocks (split from verify) | `/businesses/{id}/preview` |
| `teta_verify_claim` | check a claim against an entity's verified blocks | `/businesses/{id}/preview` |

**Proof depth** (`teta_get_proof` → `proof_depth`) is read straight from
`verification_events` (the Temporal Moat) — no new tables or workers:
- `ots_status` — strongest OTS state across the entity's events
  (`pending` < `anchored` < `confirmed`); `null` if no events.
- `btc_timestamp_depth` — deepest Bitcoin confirmation in blocks
  (`current_btc_height() − btc_block`, reusing the cached mempool.space height
  from `twira/provenance.py`); `null` when nothing is confirmed or the height is
  unavailable.
- `c2pa_chain_length` — number of C2PA manifests surfaced in `c2pa_proofs`.
- `event_count` — total verification events for the entity.

Keep `teta_*` names stable — agents depend on them. The two `.well-known/agent.json`
files (landing `landing/.well-known/agent.json` and app
`web/src/app/.well-known/agent.json/route.ts`) advertise the tool list and must be
kept in sync with the manifest.

## Build & deploy
- Local build: `cd mcp && npx tsc` → `mcp/dist/`.
- CI (`.github/workflows/deploy.yml`) builds with `tsc`, rsyncs `mcp/dist/` +
  `mcp/package.json`, runs `npm install --omit=dev`, restarts `tetapi-mcp`.
- Lockfile is at repo root (npm workspaces) — do **not** rsync `mcp/package-lock.json`.

## Adding a tool (checklist)
1. Add a client fn in `mcp/src/client.ts` if a new API call is needed.
2. `server.tool("teta_…", description, zodSchema, handler)` in `mcp/src/index.ts`.
3. Add to the `/.well-known/mcp` manifest tool list and bump version.
4. Add to both `agent.json` files (`mcp_tools`).
5. `npx tsc` typecheck, commit, push; verify `mcp.tetapi.dev/.well-known/mcp`.

## Client setup

The server is remote HTTP (no install needed) at `https://mcp.tetapi.dev/mcp`.
No auth required yet (2.2 will add agent auth for write tools; all current
tools are read-only).

**Claude Code:**
```
claude mcp add --transport http teta-pi https://mcp.tetapi.dev/mcp
```

**Claude Desktop** — Settings → Connectors → Add custom connector → URL
`https://mcp.tetapi.dev/mcp`. Or edit `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "teta-pi": {
      "type": "http",
      "url": "https://mcp.tetapi.dev/mcp"
    }
  }
}
```

**Cursor** — Settings → MCP → Add new MCP server, or add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "teta-pi": {
      "url": "https://mcp.tetapi.dev/mcp"
    }
  }
}
```

**Generic HTTP client** — standard Streamable HTTP transport: `POST /mcp` with
`Content-Type: application/json`, `Accept: application/json, text/event-stream`;
send `initialize` first, reuse the returned `Mcp-Session-Id` header on every
following request. `GET /mcp` and `DELETE /mcp` (with the same session header)
are supported for the SSE stream and explicit session close.

**MCP Inspector:**
```
npx @modelcontextprotocol/inspector https://mcp.tetapi.dev/mcp --transport http
```

## Listings (metadata prepared, submission is owner-approved)

Do not submit any of these — this just gets the metadata ready in-repo so the
owner can publish when ready.

- **Official MCP registry** (`registry.modelcontextprotocol.io`) — manifest at
  [`mcp/server.json`](../mcp/server.json), namespace `dev.tetapi/mcp`.
  Publishing needs a one-time namespace proof: either a DNS TXT record on
  `tetapi.dev` (domain namespace, matches the manifest as written) or switch
  `name` to `io.github.teta-pi/mcp` and authenticate via GitHub OAuth instead.
  Once verified, publish with the `mcp-publisher` CLI from `mcp/`
  (`mcp-publisher publish`) — owner-run, not automated here.
- **Claude connectors directory** — submitted via Anthropic's directory
  process (not a repo file). Have ready: name "TETA+PI", one-line description
  ("Verify people, businesses, journalists, artists and organizations — proof
  you can check, not a claim you take on faith"), category (Productivity /
  Developer Tools — trust & verification isn't a listed category yet, pick
  closest), remote URL `https://mcp.tetapi.dev/mcp`, auth: none, icon: TBD
  (needs a square logo asset, not yet produced).
- **Other catalogs** (Smithery, PulseMCP, mcp.so, Glama) — these largely
  crawl the official registry or accept a GitHub repo URL directly, so most
  will pick this up automatically once the official registry listing is live
  and/or `mcp/server.json` exists in the public repo. No separate manifest
  needed; if one asks for details by hand, reuse the same name/description/
  URL above.

## Roadmap for MCP (see docs/roadmap.md)
Turn TWIRA into the differentiator: richer `teta_resolve_intent` output, streaming
results, agent-to-agent verification, and (later) MCP write tools once auth for
agents is designed. This is the module the user wants to invest in next.
