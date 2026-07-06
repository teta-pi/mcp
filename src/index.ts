import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  searchBusinesses,
  getBusinessProfile,
  getVerificationProof,
  verifyEndpoint,
  resolveIntent,
} from "./client.js";

const server = new McpServer({
  name: "teta-pi",
  version: "1.2.0",
});

// ── Tool 1: teta_verify_entity ──────────────────────────────────────────────

server.tool(
  "teta_verify_entity",
  "Retrieve the full verified profile of an entity — business, journalist, or artist: " +
    "registry attestation, content blocks with media provenance, and AI-extracted categories. " +
    "Requires a UUID from teta_search.",
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
    ]
      .join("\n")
      .trim();

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool 3: teta_verify_claim ────────────────────────────────────────────────

server.tool(
  "teta_verify_claim",
  "Check whether a specific claim about an entity is supported by its verified " +
    "content blocks. Returns the evidence for you to reason over, " +
    "along with the trust level of that evidence.",
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
              `Trust level: ${profile.trust_level.toUpperCase()}`,
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
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool 4: teta_get_proof ───────────────────────────────────────────────────

server.tool(
  "teta_get_proof",
  "Retrieve raw cryptographic proof for an entity: registry attestation hash, " +
    "C2PA manifest hashes, and Bitcoin OpenTimestamps proofs. " +
    "Use when you need machine-verifiable proof rather than a human-readable summary.",
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

    const text = [
      `# Cryptographic Proof — ${id}`,
      "",
      "## Registry Attestation",
      ...regLines,
      "",
      `## C2PA Manifests (${proof.c2pa_proofs.length})`,
      ...c2paLines,
      "",
      `## Bitcoin OpenTimestamps (${proof.bitcoin_proofs.length})`,
      ...btcLines,
    ]
      .join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool 5: teta_verify_endpoint ─────────────────────────────────────────────

server.tool(
  "teta_verify_endpoint",
  "Verify that an agent endpoint (domain or URL) is active, belongs to a declared entity, " +
    "and is consistent with the verified profile on TETA+PI. " +
    "Use before routing requests to an agent to confirm the endpoint is legitimate.",
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

    const text = [
      `# Endpoint Verification`,
      `Endpoint: ${endpoint_url}`,
      entity_id ? `Entity:   ${entity_id}` : null,
      "",
      `Verdict: ${verdict}`,
      "",
      "## Checks",
      ...statusLines,
    ]
      .filter((l) => l !== null)
      .join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool 6: teta_search ──────────────────────────────────────────────────────

server.tool(
  "teta_search",
  "Search verified entities by name, domain, intent, type, or location. " +
    "Returns businesses, journalists, artists, and organizations with verification level and agent endpoints. " +
    "Use the returned entity ID with teta_verify_entity or teta_get_proof for full details.",
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
            level: verified_only ? undefined : "any",
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
        (e.description ? `\n   ${e.description.slice(0, 100)}` : "")
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
  "Resolve a natural-language intent into TWIRA-ranked verified entities. " +
    "TWIRA = α·Trust + β·Intent-alignment + γ·Provenance — ranking earned through " +
    "verification history, not ads. Each result carries a full per-component T/I/P " +
    "breakdown, first_verified_at (the temporal moat), agent endpoint, and a proof " +
    "URL. Narrow results with entity_types (one or more types) and min_trust.",
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
  "Get the full public profile of a verified entity, including its public blocks " +
    "(content, documents, media). Split from teta_verify_entity for cleaner agent UX: " +
    "use verify for trust decisions, profile for content.",
  {
    id: z.string().uuid().describe("Entity UUID from teta_search"),
  },
  async ({ id }) => {
    const profile = await getBusinessProfile(id);
    const blocks = (profile.blocks ?? [])
      .map((b: any, i: number) => {
        const media = (b.media ?? [])
          .map((m: any) => `      - ${m.media_type ?? "media"}: ${m.url ?? m.id}`)
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
            (blocks ? `\nPublic blocks:\n${blocks}` : "\nNo public blocks yet."),
        },
      ],
    };
  }
);

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

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});

await server.connect(transport);

const { createServer } = await import("node:http");

const httpServer = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "teta-pi-mcp", version: "1.2.0" }));
    return;
  }

  if (req.method === "GET" && req.url === "/.well-known/mcp") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        name: "teta-pi",
        version: "1.2.0",
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

  await transport.handleRequest(req, res);
});

httpServer.listen(PORT, () => {
  console.log(`TETA+PI MCP Server running on http://localhost:${PORT}`);
  console.log(`  /.well-known/mcp  — server manifest`);
  console.log(`  /health           — health check`);
  console.log(`  /mcp              — MCP HTTP+SSE endpoint`);
});
