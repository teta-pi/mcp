// 2.10 — Redis-backed rate limiting (S-10, MCP side).
//
// The pattern to beat: teta-pi/api tests/test_ratelimit.py. A fake Redis
// stands in for the real one — these tests are about the module's
// contract (shared budget, window expiry, documented failure mode), same
// as the Python side; only a real Redis exercises actual Lua syntax
// (covered by hitting the live /mcp endpoint by hand, see the PR).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRateLimit, RateLimiterUnavailableError, type RedisLike } from "./ratelimit.js";

class FakeRedis implements RedisLike {
  private store = new Map<string, { count: number; expiresAt: number | null }>();
  now = 0;

  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    const key = options.keys[0];
    const windowSeconds = Number(options.arguments[0]);
    let entry = this.store.get(key);
    if (entry && entry.expiresAt !== null && this.now >= entry.expiresAt) entry = undefined;
    const count = (entry?.count ?? 0) + 1;
    const expiresAt = count === 1 ? this.now + windowSeconds : entry!.expiresAt;
    this.store.set(key, { count, expiresAt });
    return count;
  }
}

class BrokenRedis implements RedisLike {
  async eval(): Promise<unknown> {
    throw new Error("connection refused");
  }
}

test("shared budget across two callers sharing one Redis — the exact bug S-10 closes", async () => {
  const redis = new FakeRedis();
  const getClient = async () => redis;
  const key = "ratelimit:test:1.2.3.4";
  for (let i = 0; i < 5; i++) {
    assert.equal(await evaluateRateLimit(getClient, key, { limit: 5, windowSeconds: 60, failOpen: true }), true);
  }
  // Under the old per-process Map, a second "worker" (= a second call site
  // hitting the same fake store here) would have had its own fresh budget.
  assert.equal(await evaluateRateLimit(getClient, key, { limit: 5, windowSeconds: 60, failOpen: true }), false);
});

test("window expires and the budget resets", async () => {
  const redis = new FakeRedis();
  const getClient = async () => redis;
  const key = "ratelimit:test:expiry";
  for (let i = 0; i < 3; i++) {
    assert.equal(await evaluateRateLimit(getClient, key, { limit: 3, windowSeconds: 60, failOpen: true }), true);
  }
  assert.equal(await evaluateRateLimit(getClient, key, { limit: 3, windowSeconds: 60, failOpen: true }), false);

  redis.now += 60;
  assert.equal(await evaluateRateLimit(getClient, key, { limit: 3, windowSeconds: 60, failOpen: true }), true);
});

test("fail_open=true: Redis unreachable lets the request through unlimited", async () => {
  const getClient = async () => new BrokenRedis();
  const allowed = await evaluateRateLimit(getClient, "k", { limit: 1, windowSeconds: 60, failOpen: true });
  assert.equal(allowed, true);
});

test("fail_open=false: Redis unreachable rejects, never a bare throw/crash", async () => {
  const getClient = async () => new BrokenRedis();
  await assert.rejects(
    () => evaluateRateLimit(getClient, "k", { limit: 1, windowSeconds: 60, failOpen: false }),
    RateLimiterUnavailableError
  );
});
