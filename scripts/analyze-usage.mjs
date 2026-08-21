#!/usr/bin/env node
// Off-server usage analytics for TWIRA weight tuning (roadmap 2.4).
//
// Reads the structured per-call JSON log lines already emitted by
// `withCallLogging`/`logToolCall` in `src/index.ts` (2.9 hardening + the 2.4
// `session` field added alongside it) and reconstructs (query, clicked_entity)
// pairs: a `teta_search`/`teta_resolve_intent` call's `entity` is the query
// text; the next entity-lookup call in the SAME `session` is treated as the
// "clicked" entity. No new logging, no new server-side state — this is pure
// after-the-fact aggregation over what `journalctl -u tetapi-mcp` already has.
//
// Usage:
//   ssh tetapi "journalctl -u tetapi-mcp --since '7 days ago' -o cat --no-pager" \
//     | node scripts/analyze-usage.mjs
//
// Or against a local file:
//   node scripts/analyze-usage.mjs < mcp.log
//
// Runs entirely off the server: no prod credentials in this script, no
// network calls — it only reads whatever log text is piped into stdin.

import { createInterface } from "node:readline";

const QUERY_TOOLS = new Set(["teta_search", "teta_resolve_intent"]);
const LOOKUP_TOOLS = new Set([
  "teta_verify_entity",
  "teta_get_profile",
  "teta_verify_claim",
  "teta_get_proof",
]);

const bySession = new Map(); // session -> chronological array of log entries
let totalLines = 0;
let parsedCalls = 0;
let noSession = 0;

const rl = createInterface({ input: process.stdin, terminal: false });

for await (const line of rl) {
  totalLines++;
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") continue;

  let entry;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    continue;
  }
  if (typeof entry.tool !== "string" || typeof entry.ts !== "string") continue;

  parsedCalls++;
  if (!entry.session) {
    noSession++;
    continue;
  }
  if (!bySession.has(entry.session)) bySession.set(entry.session, []);
  bySession.get(entry.session).push(entry);
}

// (query, clicked_entity) pair counts, keyed by JSON so query text (which
// may itself contain spaces) can't collide with a plain string separator.
const pairs = new Map(); // JSON.stringify([query, entity]) -> count
let pairedQueries = 0;
let unpairedQueries = 0;

for (const calls of bySession.values()) {
  calls.sort((a, b) => a.ts.localeCompare(b.ts));

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (!QUERY_TOOLS.has(call.tool) || call.status !== "ok" || !call.entity) continue;

    const next = calls
      .slice(i + 1)
      .find((c) => LOOKUP_TOOLS.has(c.tool) && c.status === "ok" && c.entity);

    if (!next) {
      unpairedQueries++;
      continue;
    }
    pairedQueries++;
    const key = JSON.stringify([call.entity, next.entity]);
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
}

const ranked = [...pairs.entries()]
  .map(([key, count]) => {
    const [query, entity] = JSON.parse(key);
    return { query, clicked_entity: entity, count };
  })
  .sort((a, b) => b.count - a.count);

console.log(
  JSON.stringify(
    {
      summary: {
        log_lines_read: totalLines,
        tool_calls_parsed: parsedCalls,
        calls_without_session: noSession,
        sessions_seen: bySession.size,
        query_to_click_pairs_found: pairedQueries,
        queries_with_no_followup_lookup: unpairedQueries,
      },
      pairs: ranked,
    },
    null,
    2
  )
);
