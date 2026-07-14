# TETA+PI MCP Server

TypeScript server exposing the **TETA+PI** verified entity registry to AI
agents via the [Model Context Protocol](https://modelcontextprotocol.io).
Live at [`mcp.tetapi.dev`](https://mcp.tetapi.dev).

## Connect

```yaml
mcp_servers:
  - name: teta-pi
    url: https://mcp.tetapi.dev/sse
    auth: Bearer
```

## Tools (7)
| Tool | Purpose |
|---|---|
| `teta_search` | search verified entities by name/type/country |
| `teta_resolve_intent` | **flagship** — TWIRA-ranked routing from a natural-language intent, with `entity_types` + `min_trust` filters |
| `teta_verify_entity` | full verified profile + registry attestation |
| `teta_get_profile` | public profile + public blocks |
| `teta_verify_endpoint` | confirm a domain/endpoint belongs to a verified entity |
| `teta_verify_claim` | check a claim against an entity's verified blocks |
| `teta_get_proof` | raw cryptographic proof — registry hash, C2PA chain, Bitcoin OTS depth |

Stateless — every call hits `api.tetapi.dev` over HTTP. HTTP + SSE transport,
one session per client (`@modelcontextprotocol/sdk`).

## Docs
Canonical docs live in [`teta-pi/infra`](https://github.com/teta-pi/infra):
see `docs/mcp.md`.

## License
MIT © 2026 TETA+PI · tetapi.dev
