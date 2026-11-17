// Shared Redis-backed rate limiting (S-10, docs/security.md — MCP side).
//
// Mirrors `teta-pi/api` `app/core/ratelimit.py`: one atomic INCR+EXPIRE (Lua)
// call per hit, fixed-window, so N restarts or (if this process ever runs
// with >1 worker) N workers all see one shared counter instead of each
// keeping its own in-memory `dict`/`Map` — the exact gap that let the old
// per-process limiter's real ceiling drift to `limit × workers` and reset
// to zero on every restart.
//
// Fixed-window, not sliding, same trade-off the API side already made: a
// key counts hits since it was first touched and expires `windowSeconds`
// later, so a caller can in principle burst up to 2x `limit` across a
// window boundary. Not worth an extra Redis round trip (ZADD/ZREMRANGEBYSCORE)
// for a limiter whose job is "bound worst-case cost", not "meter precisely".
//
// fail_open=true for `/mcp`: unlike the API's `/auth/*` limiters, there is
// no credential or secret behind this door for a Redis outage to expose —
// `/mcp` is unauthenticated by design (S-11) and every tool call is already
// a public, read-only proxy onto `api.tetapi.dev`. The limiter here exists
// to bound cost/availability (an anonymous ingress spending API capacity),
// the same category the API's own rule already puts `badge`/`tag-ping`/
// `claim`/`verify-endpoint` in — not to stop brute-forcing a login. A Redis
// blip should cost MCP a temporarily-unbounded limit, never an outage on
// the one surface agents use to verify trust claims.
import { createClient, type RedisClientType } from "redis";

const INCR_EXPIRE_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export interface RedisLike {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  /** true: Redis unreachable lets the request through unlimited.
   *  false: Redis unreachable rejects — never a bare 500, see `RateLimiterUnavailableError`. */
  failOpen: boolean;
}

export class RateLimiterUnavailableError extends Error {
  constructor() {
    super("Rate limiter temporarily unavailable, try again shortly");
  }
}

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;

async function getRedisClient(): Promise<RedisLike> {
  if (client) return client;
  if (!connecting) {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    const c: RedisClientType = createClient({ url });
    // Without a handler, node-redis's own "error" emission on a dropped
    // connection is an unhandled EventEmitter error, which crashes the
    // process — the one thing fail_open exists to avoid.
    c.on("error", (err) => {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "redis_connection_error",
          error: err instanceof Error ? err.message : String(err),
        })
      );
    });
    connecting = c.connect().then(() => {
      client = c;
      return c;
    });
  }
  return connecting;
}

function logRedisFailure(key: string, failOpen: boolean, err: unknown): void {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "ratelimit_redis_unreachable",
      key,
      fail_open: failOpen,
      error: err instanceof Error ? err.message : String(err),
    })
  );
}

// Core logic, parameterized over how to get a client — lets tests supply a
// fake Redis (same shape as `teta-pi/api`'s `tests/test_ratelimit.py`
// `FakeRedis`) without a real connection.
export async function evaluateRateLimit(
  getClient: () => Promise<RedisLike>,
  key: string,
  { limit, windowSeconds, failOpen }: RateLimitOptions
): Promise<boolean> {
  let redis: RedisLike;
  try {
    redis = await getClient();
  } catch (err) {
    logRedisFailure(key, failOpen, err);
    if (failOpen) return true;
    throw new RateLimiterUnavailableError();
  }
  try {
    const count = Number(await redis.eval(INCR_EXPIRE_LUA, { keys: [key], arguments: [String(windowSeconds)] }));
    return count <= limit;
  } catch (err) {
    logRedisFailure(key, failOpen, err);
    if (failOpen) return true;
    throw new RateLimiterUnavailableError();
  }
}

/** Touches `key`'s counter and reports whether the caller is still within
 * `limit` hits per `windowSeconds`. `true` = allowed. */
export async function checkRateLimit(key: string, options: RateLimitOptions): Promise<boolean> {
  return evaluateRateLimit(getRedisClient, key, options);
}

// `clientIp()` reads `X-Forwarded-For` first, same as before this change —
// a deliberate choice, not a leftover. S-30 (docs/security.md) found this
// exact read forged and bypassable on both api.tetapi.dev and
// mcp.tetapi.dev; the fix on the api side was to switch to `X-Real-IP`
// (nginx-set from `$remote_addr`), but `mcp.tetapi.dev`'s vhost deliberately
// sets no `X-Real-IP` — nothing upstream of this process reads it, so
// there's never been a reason to add it. What actually closes S-30 for MCP
// (infra 5.20, confirmed live) is `proxy_set_header X-Forwarded-For
// $remote_addr;` (overwrite, not `$proxy_add_x_forwarded_for`) on both
// `mcp.tetapi.dev` server blocks — nginx is the control, not this function.
// Reading `X-Forwarded-For` here is safe only as long as that one nginx line
// stays correct; it is not re-derived or re-verified by this code.
export function clientIp(req: import("node:http").IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  return (first ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
}
