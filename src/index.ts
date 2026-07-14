import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchBusinesses,
  getBusinessProfile,
  getVerificationProof,
  verifyEndpoint,
  resolveIntent,
} from "./client.js";

export const SERVER_VERSION = "1.5.0";

// Public URLs for proof_url — always the public hostnames, independent of
// TETA_PI_API_URL (which may point at an internal address). The entity page
// needs a real slug (by-slug lookup); the /proof endpoint takes the UUID
// every tool already has.
const PUBLIC_API_BASE = "https://api.tetapi.dev/api/v1";
const PUBLIC_APP_BASE = "https://app.tetapi.dev";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function proofUrlById(id: string): string {
  return `${PUBLIC_API_BASE}/businesses/${id}/proof`;
}

function entityPageUrl(slug: string): string {
  return `${PUBLIC_APP_BASE}/e/${slug}`;
}

// Each client session gets its own McpServer instance (registerTools is pure —
// tool handlers hold no state, they just call api.tetapi.dev per invocation).
// A single shared instance would mean only one client could ever be connected
// at a time; see the `sessions` map in the HTTP bootstrap below.
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "teta-pi",
    version: SERVER_VERSION,
  });

  registerTools(server);
  return server;
}

function registerTools(server: McpServer): void {
// ── Tool 1: teta_verify_entity ──────────────────────────────────────────────

server.tool(
  "teta_verify_entity",
  "Verify if a business, journalist, or artist is real before your agent trusts a claim " +
    "about them: registry attestation, content blocks with media provenance, and " +
    "AI-extracted categories. Requires a UUID from teta_search.",
  {
    id: z.string().uuid().describe("Entity UUID from teta_search"),
  },
  async ({ id }) => {
    const profile = await getBusinessProfile(id);

    const reg = profile.registry ?? {};
    const regLines = [
      reg["registry"] ? `  registry: ${reg["registry"]}` : null,
      reg["registration_number"] ? `  number: ${reg["registration_number"]}` : null,
      reg["status"] ? `  status: ${reg["status"]}` : null,
      reg["legal_name"] ? `  legal_name: ${reg["legal_name"]}` : null,
      reg["address"] ? `  address: ${reg["address"]}` : null,
      reg["verified_at"] ? `  verified_at: ${reg["verified_at"]}` : null,
    ].filter(Boolean);

    const blockLines = profile.blocks.map((b) => {
      const mediaLines = b.media.map((m) => {
        const flags: string[] = [];
        if (m.c2pa_verified) flags.push("C2PA-signed");
        if (m.bitcoin_confirmed) flags.push(`BTC-confirmed block #${m.bitcoin_block}`);
        const captured = m.captured_at ? ` captured ${m.captured_at}` : "";
        return `    - ${m.type}${captured}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
      });
      return [
        `  Block: ${b.title}`,
        b.description ? `    ${b.description}` : null,
        ...mediaLines,
      ]
        .filter(Boolean)
        .join("\n");
    });

    const aiCats = profile.registry?.["ai_categories"] as Record<string, unknown> | undefined;
    const catLines = aiCats
      ? [
          aiCats["industry"] ? `  industry: ${aiCats["industry"]}` : null,
          aiCats["sub_category"] ? `  sub_category: ${aiCats["sub_category"]}` : null,
          Array.isArray(aiCats["claims"]) && aiCats["claims"].length
            ? `  claims: ${(aiCats["claims"] as string[]).join(", ")}`
            : null,
        ].filter(Boolean)
      : ["  (not yet categorized)"];

    const text = [
      `# ${profile.name}`,
      profile.description ?? "",
      "",
      `Trust level: ${profile.trust_level.toUpperCase()}`,
      "",
      "## Registry Attestation",
      regLines.length ? regLines.join("\n") : "  (no registry data)",
      "",
      `## Content Blocks (${profile.blocks.length})`,
      profile.blocks.length ? blockLines.join("\n\n") : "  (none)",
      "",
      "## AI Categories",
      catLines.join("\n"),
      "",
      `Proof: ${proofUrlById(id)}`,
    ]
      .join("\n")
      .trim();

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool 3: teta_verify_claim ────────────────────────────────────────────────

server.tool(
  "teta_verify_claim",
  "Check a specific claim about an entity against its verified evidence — e.g. " +
    "'ISO 9001 certified' or 'has a Berlin office' — before your agent repeats it. " +
    "Returns the supporting evidence and its trust level for you to reason over.",
  {
    id: z.string().uuid().describe("Entity UUID from teta_search"),
    claim: z
      .string()
      .max(500)
      .describe(
        "The claim to evaluate, e.g. 'This company is ISO 9001 certified' " +
          "or 'They operate a physical office in Berlin'"
      ),
  },
  async ({ id, claim }) => {
    const profile = await getBusinessProfile(id);

    if (profile.blocks.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `INSUFFICIENT EVIDENCE\n\n` +
              `"${profile.name}" has no verified content blocks.\n` +
              `Cannot evaluate: "${claim}"\n\n` +
              `Trust level: ${profile.trust_level.toUpperCase()}\n` +
              `Proof: ${proofUrlById(id)}`,
          },
        ],
      };
    }

    const evidence = profile.blocks
      .map((b) => {
        const mediaDesc = b.media
          .map((m) => {
            const flags: string[] = [];
            if (m.c2pa_verified) flags.push("C2PA-signed by PI Camera");
            if (m.bitcoin_confirmed) flags.push(`Bitcoin-timestamped block #${m.bitcoin_block}`);
            return `${m.type}${flags.length ? ` (${flags.join(", ")})` : " (unverified)"}`;
          })
          .join("; ");
        return [
          `Block "${b.title}":`,
          b.description ? `  "${b.description}"` : null,
          mediaDesc ? `  Media: ${mediaDesc}` : null,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");

    const text = [
      `Evaluating claim for: ${profile.name}`,
      `Trust level: ${profile.trust_level.toUpperCase()}`,
      ``,
      `Claim: "${claim}"`,
      ``,
      `Verified evidence:`,
      evidence,
      ``,
      trustLevelNote(profile.trust_level),
      `Proof: ${proofUrlById(id)}`,
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool 4: teta_get_proof ───────────────────────────────────────────────────

server.tool(
  "teta_get_proof",
  "Pull the raw cryptographic proof behind an entity's verification — registry " +
    "attestation hash, C2PA manifest hashes, Bitcoin OpenTimestamps — so your agent " +
    "can set its own trust threshold instead of taking a badge on faith. Includes " +
    "proof depth: OTS status (pending/anchored/confirmed), Bitcoin timestamp depth " +
    "in blocks, and C2PA chain length.",
  {
    id: z.string().uuid().describe("Entity UUID"),
  },
  async ({ id }) => {
    const proof = await getVerificationProof(id);

    const regLines = [
      `  source: ${proof.registry_proof.source || "(none)"}`,
      proof.registry_proof.verified_at
        ? `  verified_at: ${proof.registry_proof.verified_at}`
        : null,
      proof.registry_proof.data_hash ? `  hash: ${proof.registry_proof.data_hash}` : null,
    ].filter(Boolean);

    const c2paLines =
      proof.c2pa_proofs.length > 0
        ? proof.c2pa_proofs.map(
            (p) => `  ${p.media_id}\n    hash: ${p.manifest_hash}\n    signer: ${p.signer ?? "unknown"}`
          )
        : ["  (none)"];

    const btcLines =
      proof.bitcoin_proofs.length > 0
        ? proof.bitcoin_proofs.map(
            (p) =>
              `  ${p.media_id}` +
              (p.bitcoin_block ? `\n    block: #${p.bitcoin_block}` : "") +
              `\n    proof: ${p.ots_proof_url}`
          )
        : ["  (none)"];

    const depth = proof.proof_depth;
    const depthLines = [
      `  ots_status: ${depth.ots_status ?? "(no events)"}`,
      `  btc_timestamp_depth: ${
        depth.btc_timestamp_depth != null ? `${depth.btc_timestamp_depth} blocks` : "(not confirmed)"
      }`,
      `  c2pa_chain_length: ${depth.c2pa_chain_length}`,
      `  event_count: ${depth.event_count}`,
    ];

    const text = [
      `# Cryptographic Proof — ${id}`,
      "",
      "## Proof Depth",
      ...depthLines,
      "",
      "## Registry Attestation",
      ...regLines,
      "",
      `## C2PA Manifests (${proof.c2pa_proofs.length})`,
      ...c2paLines,
      "",
      `## Bitcoin OpenTimestamps (${proof.bitcoin_proofs.length})`,
      ...btcLines,
      "",
      `Proof: ${proofUrlById(id)}`,
    ]
      .join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool 5: teta_verify_endpoint ─────────────────────────────────────────────

server.tool(
  "teta_verify_endpoint",
  "Confirm an agent endpoint is live, actually belongs to the entity it claims to, and " +
    "matches its verified profile — run this before your agent routes a request or a " +
    "payment to it.",
  {
    endpoint_url: z.string().url().describe("The agent endpoint URL to verify"),
    entity_id: z
      .string()
      .optional()
      .describe("Entity slug or UUID on TETA+PI (optional but recommended)"),
  },
  async ({ endpoint_url, entity_id }) => {
    const result = await verifyEndpoint({ endpoint_url, entity_id });

    const statusLines = [
      `  active:            ${result.is_active ? "✓ yes" : "✗ no"}`,
      `  belongs to entity: ${result.belongs_to_entity ? "✓ yes" : "✗ no"}`,
      `  data consistent:   ${result.data_consistent ? "✓ yes" : "✗ no"}`,
      `  last checked:      ${result.last_checked}`,
      result.verification_proof ? `  proof:             ${result.verification_proof}` : null,
    ].filter(Boolean);

    const allPassed = result.is_active && result.belongs_to_entity && result.data_consistent;
    const verdict = allPassed
      ? "VERIFIED — endpoint is active, ownership confirmed, data consistent."
      : !result.is_active
      ? "FAILED — endpoint did not respond."
      : !result.belongs_to_entity
      ? "UNVERIFIED — endpoint domain does not match the declared entity."
      : "PARTIAL — endpoint is active but data does not match the verified profile.";

    // entity_id may be a slug or a UUID (per param description) — the /proof
    // endpoint takes a UUID, so only surface a proof_url when we have one.
    const proofUrl = entity_id && UUID_RE.test(entity_id) ? proofUrlById(entity_id) : null;

    const text = [
      `# Endpoint Verification`,
      `Endpoint: ${endpoint_url}`,
      entity_id ? `Entity:   ${entity_id}` : null,
      "",
      `Verdict: ${verdict}`,
      "",
      "## Checks",
      ...statusLines,
      proofUrl ? "" : null,
      proofUrl ? `Proof: ${proofUrl}` : null,
    ]
      .filter((l) => l !== null)
      .join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool 6: teta_search ──────────────────────────────────────────────────────

server.tool(
  "teta_search",
  "Find a real, verified business, person, journalist, artist, or organization by name, " +
    "domain, or location — before your agent trusts a claim or routes to it. Returns " +
    "verification level and agent endpoints; feed the entity ID to teta_verify_entity " +
    "or teta_get_proof for full details.",
  {
    query: z.string().describe("Natural language query, e.g. 'organic bakery Berlin' or 'investigative journalist Ukraine'"),
    entity_type: z
      .enum(["business", "person", "organization", "all"])
      .default("all")
      .describe("Filter by entity type (default: all)"),
    country: z
      .string()
      .length(2)
      .optional()
      .describe("ISO 3166-1 alpha-2 country code, e.g. 'DE', 'UA', 'GB'"),
    verified_only: z
      .boolean()
      .default(true)
      .describe("Only return registry-verified entities (default: true)"),
    has_agent_endpoint: z
      .boolean()
      .optional()
      .describe("Filter to entities that have a declared agent endpoint"),
    limit: z.number().int().min(1).max(50).default(10),
  },
  async ({ query, entity_type, country, verified_only, has_agent_endpoint, limit }) => {
    // For "all" we run parallel searches across entity types
    const types = entity_type === "all" ? ["business", "person", "organization"] : [entity_type];

    const allResults = (
      await Promise.all(
        types.map((et) =>
          searchBusinesses({
            q: query,
            entity_type: et,
            country,
            has_agent_endpoint,
            limit,
            level: verified_only ? "registry" : "any",
          }).then((r) => r.results)
        )
      )
    )
      .flat()
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, limit);

    if (allResults.length === 0) {
      return {
        content: [{ type: "text", text: `No verified entities found for "${query}".` }],
      };
    }

    const lines = allResults.map((e, i) => {
      const level = e.verification_level.toUpperCase();
      const type = e.entity_type.toUpperCase();
      const loc = e.country ? ` · ${e.country}` : "";
      const ep = e.agent_endpoint
        ? `\n   endpoint: ${e.agent_endpoint}${e.agent_endpoint_verified ? " [verified]" : " [unverified]"}`
        : "";
      return (
        `${i + 1}. [${type}][${level}]${loc} ${e.name}` +
        `\n   id: ${e.id}${ep}` +
        (e.description ? `\n   ${e.description.slice(0, 100)}` : "") +
        `\n   proof: ${entityPageUrl(e.slug)}`
      );
    });

    return {
      content: [
        {
          type: "text",
          text:
            `Found ${allResults.length} entity/entities for "${query}":\n\n` +
            lines.join("\n\n") +
            "\n\nUse teta_verify_entity(id) for full profile or teta_verify_endpoint(endpoint_url, entity_id) to verify an agent.",
        },
      ],
    };
  }
);

// ── Tool 7: teta_resolve_intent (flagship — TWIRA-ranked routing) ─────────────

server.tool(
  "teta_resolve_intent",
  "Ask for what your agent needs in plain language — 'a verified pizza restaurant in " +
    "Lisbon', 'a real investigative journalist in Ukraine' — and get back TWIRA-ranked " +
    "verified entities, ranked by earned verification history, not ads. Each result " +
    "carries a full per-component T/I/P breakdown, first_verified_at (the temporal " +
    "moat), agent endpoint, and a proof URL. Narrow with entity_types and min_trust.",
  {
    query: z.string().describe("Natural language intent, e.g. 'verified pizza restaurant in Lisbon'"),
    entity_types: z
      .array(z.enum(["business", "person", "organization"]))
      .optional()
      .describe("Filter to one or more entity types (default: business)"),
    min_trust: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Minimum Trust component (T) score, 0–1. Drops entities whose verification " +
          "history is weaker than this threshold."
      ),
    limit: z.number().int().min(1).max(50).default(10),
  },
  async ({ query, entity_types, min_trust, limit }) => {
    const res = await resolveIntent({
      query,
      entity_types: entity_types && entity_types.length ? entity_types : undefined,
      min_trust,
    });
    const results = res.results.slice(0, limit);

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `No entities resolved for intent "${query}".` }],
      };
    }

    const lines = results.map((r: any, i: number) => {
      const level = r.verification_level.toUpperCase();
      const parts: string[] = [
        `${i + 1}. ${r.entity_name} — ${String(r.entity_type).toUpperCase()} · ${level}`,
        `   id: ${r.entity_id}`,
        r.twira
          ? `   twira: ${r.twira.score}  ·  T(trust)=${r.twira.t} I(intent)=${r.twira.i} P(provenance)=${r.twira.p}`
          : `   relevance: ${r.relevance_score}`,
      ];
      if (r.first_verified_at) parts.push(`   first_verified_at: ${r.first_verified_at}`);
      if (r.country) parts.push(`   country: ${r.country}`);
      if (r.agent_endpoint)
        parts.push(
          `   endpoint: ${r.agent_endpoint}${r.agent_endpoint_verified ? " [verified]" : " [unverified]"}`
        );
      if (r.proof_url) parts.push(`   proof: ${r.proof_url}`);
      return parts.join("\n");
    });

    const filters = [
      entity_types && entity_types.length ? `types=${entity_types.join(",")}` : null,
      min_trust != null ? `min_trust=${min_trust}` : null,
    ].filter(Boolean);

    const header =
      `TWIRA-ranked results for "${query}"` +
      (filters.length ? ` (${filters.join(", ")})` : "");

    return {
      content: [
        {
          type: "text",
          text: [
            header,
            "TWIRA = α·Trust + β·Intent-alignment + γ·Provenance — earned through verification history, not ads; components are 0–1.",
            "",
            lines.join("\n\n"),
            "",
            "Each result's proof URL returns machine-verifiable registry + C2PA + Bitcoin proof. Call teta_verify_endpoint(endpoint_url, entity_id) before routing to an agent.",
          ].join("\n"),
        },
      ],
    };
  }
);

// ── Tool 8: teta_get_profile ──────────────────────────────────────────────────

server.tool(
  "teta_get_profile",
  "Pull an entity's public content — documents, media, written blocks — once your agent " +
    "already trusts it. Use teta_verify_entity first for the trust decision; use this " +
    "one for the content itself.",
  {
    id: z.string().uuid().describe("Entity UUID from teta_search"),
  },
  async ({ id }) => {
    const profile = await getBusinessProfile(id);
    const blocks = (profile.blocks ?? [])
      .map((b: any, i: number) => {
        const media = (b.media ?? [])
          .map((m: any) => {
            const flags: string[] = [];
            if (m.c2pa_verified) flags.push("C2PA-signed");
            if (m.bitcoin_confirmed) flags.push(`BTC-confirmed block #${m.bitcoin_block}`);
            const captured = m.captured_at ? ` captured ${m.captured_at}` : "";
            return `      - ${m.type}${captured}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
          })
          .join("\n");
        return `   ${i + 1}. ${b.title}${b.description ? ` — ${b.description.slice(0, 120)}` : ""}${media ? "\n" + media : ""}`;
      })
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text:
            `Profile: ${profile.name}\n` +
            `Trust level: ${profile.trust_level.toUpperCase()}\n` +
            (profile.description ? `${profile.description}\n` : "") +
            (blocks ? `\nPublic blocks:\n${blocks}` : "\nNo public blocks yet.") +
            `\n\nProof: ${proofUrlById(id)}`,
        },
      ],
    };
  }
);
} // end registerTools

// ── Helpers ───────────────────────────────────────────────────────────────────

function trustLevelNote(level: string): string {
  switch (level) {
    case "full":
      return "Evidence strength: HIGH — registry-verified + C2PA camera-signed + Bitcoin-timestamped.";
    case "partial":
      return "Evidence strength: MEDIUM — registry-verified + Bitcoin-timestamped, no C2PA camera proof.";
    case "registry":
      return "Evidence strength: LOW — registry-verified only, no media proofs yet.";
    case "live":
      return "Evidence strength: HIGHEST — live C2PA-streaming camera feed, real-time proof.";
    default:
      return "Evidence strength: NONE — no verification completed.";
  }
}

// ── HTTP + SSE server ─────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MCP_PORT ?? "3002", 10);

// One transport per client session, keyed by the `mcp-session-id` the SDK
// assigns on initialize. A single shared transport (the old behaviour) can
// only ever have one active session for the life of the process — every
// second client (a second Claude Code window, MCP Inspector, another agent)
// gets "Server already initialized" and is locked out until a restart.
const sessions = new Map<string, StreamableHTTPServerTransport>();

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const { createServer } = await import("node:http");

const httpServer = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "teta-pi-mcp", version: SERVER_VERSION }));
    return;
  }

  if (req.method === "GET" && req.url === "/.well-known/mcp") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        name: "teta-pi",
        version: SERVER_VERSION,
        description: "TETA+PI trust infrastructure for AI agents",
        tools: [
          "teta_search",
          "teta_verify_entity",
          "teta_verify_endpoint",
          "teta_get_proof",
          "teta_resolve_intent",
          "teta_get_profile",
          "teta_verify_claim",
        ],
        transport: ["http", "sse"],
      })
    );
    return;
  }

  if (req.url !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32004, message: "Not found" }, id: null }));
    return;
  }

  const sessionIdHeader = req.headers["mcp-session-id"];
  const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  if (existing) {
    await existing.handleRequest(req, res);
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      })
    );
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
    return;
  }

  if (sessionId || !isInitializeRequest(body)) {
    // Session id was supplied but unknown (process restart, expired session,
    // or client bug) — or a fresh POST that isn't an initialize call.
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      })
    );
    return;
  }

  let transport: StreamableHTTPServerTransport;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  await createMcpServer().connect(transport);
  await transport.handleRequest(req, res, body);
});

httpServer.listen(PORT, () => {
  console.log(`TETA+PI MCP Server running on http://localhost:${PORT}`);
  console.log(`  /.well-known/mcp  — server manifest`);
  console.log(`  /health           — health check`);
  console.log(`  /mcp              — MCP HTTP+SSE endpoint`);
});
