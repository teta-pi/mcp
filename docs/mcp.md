# MCP Server

TypeScript server exposing TETA+PI to AI agents via the Model Context Protocol.
Source: `mcp/src/index.ts` (tools) + `mcp/src/client.ts` (API client). Stateless —
every tool calls `api.tetapi.dev` over HTTP. Deployed as systemd `tetapi-mcp` on
port 3002, public at `mcp.tetapi.dev`. **Version 1.2.0.**

## Transport & manifest
- HTTP + SSE via `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport`.
- `GET /.well-known/mcp` → server manifest (name, version, tool list).
- `GET /health` → status.
- `TETA_PI_API_URL` env points at the API base (`…/api/v1`).

## Tools (7)
| Tool | Purpose | Backend |
|---|---|---|
| `teta_search` | search verified entities by name/type/country | `/search` |
| `teta_verify_entity` | full verified profile + registry attestation | `/businesses/{id}/preview` |
| `teta_verify_endpoint` | confirm a domain/endpoint belongs to a verified entity | `/verify-endpoint` |
| `teta_get_proof` | raw cryptographic proof (registry hash, C2PA, BTC OTS) | `/businesses/{id}/proof` |
| `teta_resolve_intent` | **flagship** — TWIRA-ranked routing; full T/I/P breakdown, `first_verified_at`, `proof_url`; filters `entity_types` + `min_trust` | `/resolve-intent` |
| `teta_get_profile` | public profile + public blocks (split from verify) | `/businesses/{id}/preview` |
| `teta_verify_claim` | check a claim against an entity's verified blocks | `/businesses/{id}/preview` |

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

## Roadmap for MCP (see docs/roadmap.md)
Turn TWIRA into the differentiator: richer `teta_resolve_intent` output, streaming
results, agent-to-agent verification, and (later) MCP write tools once auth for
agents is designed. This is the module the user wants to invest in next.
