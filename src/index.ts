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
  version: "0.1.0",
});

// ── Tool 1: search_verified_entities (quick search) ───────────────────────────

server.tool(
  "search_verified_entities",
  "Search for verified businesses, journalists, artists, and organizations. " +
    "Returns ranked results with trust levels: 'full' (registry + C2PA + BTC), " +
    "'partial' (registry + BTC), 'registry' (registry only). " +
    "Use this to find a verified entity ID before fetching its full profile.",
  {
    query: z
      .string()
      .describe("Natural language search query, e.g. 'organic coffee roasters Berlin'"),
    trust_level: z
      .enum(["any", "registry", "partial", "full"])
      .default("any")
      .describe("Minimum trust level filter (default: any)"),
    country: z
      .string()
      .length(2)
      .optional()
      .describe("ISO 3166-1 alpha-2 country code filter, e.g. 'DE', 'UA', 'GB'"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum number of results (1–50, default 10)"),
  },
  async ({ query, trust_level, country, limit }) => {
    const data = await searchBusinesses({
      q: query,
      level: trust_level,
      country,
      limit,
    });

    if (data.results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No verified businesses found for "${query}".`,
          },
        ],
      };
    }

    const lines = data.results.map((b, i) => {
      const level = b.verification_level.toUpperCase();
      const loc = b.country ? ` · ${b.country}` : "";
      const cats = b.ai_categories;
      const industry = cats?.industry ? ` · ${cats.industry}` : "";
      const badges = b.badges.length ? `  [${b.badges.join(", ")}]` : "";
      return (
        `${i + 1}. [${level}]${loc}${industry} ${b.name}` +
        `\n   id: ${b.id}${badges}` +
        (b.description ? `\n   ${b.description.slice(0, 120)}` : "")
      );
    });

    return {
      content: [
        {
          type: "text",
          text:
            `Found ${data.total} result(s) for "${query}":\n\n` +
            lines.join("\n\n") +
            "\n\nCall get_business_profile(id) for full details on any result.",
        },
      ],
    };
  }
);

// ── Tool 2: get_business_profile ──────────────────────────────────────────────

server.tool(
  "get_business_profile",
  "Retrieve the full verified profile of a business: registry attestation, " +
    "content blocks with media provenance flags, and AI-extracted categories. " +
    "Requires a UUID from search_verified_entities.",
  {
    id: z.string().uuid().describe("Business UUID from search_verified_entities"),
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

// ── Tool 3: verify_business_claim ─────────────────────────────────────────────

server.tool(
  "verify_business_claim",
  "Check whether a specific claim about a business is supported by its verified " +
    "content blocks. Returns the verified evidence for you to reason over, " +
    "along with the trust level of that evidence.",
  {
    id: z.string().uuid().describe("Business UUID"),
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

// ── Tool 4: get_verification_proof ────────────────────────────────────────────

server.tool(
  "get_verification_proof",
  "Retrieve raw cryptographic proof for a business: registry attestation hash, " +
    "C2PA manifest hashes, and Bitcoin OpenTimestamps proofs. " +
    "Use this when you need machine-verifiable proof rather than a human-readable summary.",
  {
    id: z.string().uuid().describe("Business UUID"),
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

// ── Tool 5: verify_endpoint ───────────────────────────────────────────────────

server.tool(
  "verify_endpoint",
  "Verify that an agent endpoint is active, belongs to a declared entity, and its data " +
    "is consistent with the verified profile on TETA+PI. " +
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

// ── Tool 6: search_entities ───────────────────────────────────────────────────

server.tool(
  "search_entities",
  "Search verified entities by intent, type, or location. Returns businesses, people, " +
    "and organizations with verification status and agent endpoints. " +
    "More powerful than search_verified_entities — supports all entity types and agent endpoint filtering.",
  {
    query: z.string().describe("Natural language query, e.g. 'verified pizza restaurant Lisbon' or 'freight agent Germany'"),
    entity_type: z
      .enum(["business", "person", "organization", "all"])
      .default("all")
      .describe("Filter by entity type (default: all)"),
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
  async ({ query, entity_type, verified_only, has_agent_endpoint, limit }) => {
    // For "all" we run parallel searches across entity types
    const types = entity_type === "all" ? ["business", "person", "organization"] : [entity_type];

    const allResults = (
      await Promise.all(
        types.map((et) =>
          searchBusinesses({
            q: query,
            entity_type: et,
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
            "\n\nUse get_business_profile(id) or verify_endpoint(endpoint_url, entity_id) for details.",
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
    res.end(JSON.stringify({ status: "ok", server: "teta-pi-mcp", version: "0.1.0" }));
    return;
  }

  if (req.method === "GET" && req.url === "/.well-known/mcp") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        name: "teta-pi",
        version: "0.1.0",
        description: "TETA+PI trust infrastructure for AI agents",
        tools: [
          "search_verified_entities",
          "search_entities",
          "get_business_profile",
          "verify_business_claim",
          "get_verification_proof",
          "verify_endpoint",
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
