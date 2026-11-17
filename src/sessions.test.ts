// 2.10 — session idle sweep (S-14, docs/known-issues.md).
//
// Proves the two things the task cares about: the reap actually reaps, and
// a session that is still active (recent activity) survives a sweep pass —
// using a virtual clock so no real timers or HTTP server are needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionStore, sweepIdleSessions } from "./sessions.js";

test("an idle session past the timeout is evicted", () => {
  const store = createSessionStore<string>();
  store.sessions.set("idle-1", "transport-idle-1");
  store.lastActivity.set("idle-1", 0);

  const evicted = sweepIdleSessions(store, /* now */ 11 * 60_000, /* idleTimeoutMs */ 10 * 60_000, () => {});

  assert.deepEqual(evicted, ["idle-1"]);
});

test("a session with recent activity survives the sweep", () => {
  const store = createSessionStore<string>();
  store.sessions.set("active-1", "transport-active-1");
  store.lastActivity.set("active-1", 9 * 60_000); // touched 1 min before "now"

  const evicted = sweepIdleSessions(store, /* now */ 10 * 60_000, /* idleTimeoutMs */ 10 * 60_000, () => {});

  assert.deepEqual(evicted, []);
});

test("a mixed sweep reaps only the idle session, leaves the active one untouched", () => {
  const store = createSessionStore<string>();
  store.lastActivity.set("idle-1", 0);
  store.lastActivity.set("active-1", 9 * 60_000);

  const evicted = sweepIdleSessions(store, 11 * 60_000, 10 * 60_000, () => {});

  assert.deepEqual(evicted, ["idle-1"]);
  assert.equal(store.lastActivity.has("active-1"), true);
});

test("onEvict is called for each reaped session, so the caller can close its transport", () => {
  const store = createSessionStore<string>();
  store.lastActivity.set("idle-1", 0);
  store.lastActivity.set("idle-2", 0);

  const closed: string[] = [];
  sweepIdleSessions(store, 11 * 60_000, 10 * 60_000, (id) => closed.push(id));

  assert.deepEqual(closed.sort(), ["idle-1", "idle-2"]);
});

test("a repeated touch keeps resetting the idle window — a slow-but-alive agent is never reaped", () => {
  const store = createSessionStore<string>();
  store.lastActivity.set("slow-agent", 0);

  // 9 minutes in, the agent calls again — touch() resets the clock.
  store.touch("slow-agent");
  // Sweeping "now" (immediately after the touch) must not reap it even
  // though its *original* activity was long past the idle window.
  const evicted = sweepIdleSessions(store, Date.now() + 10 * 60_000, 10 * 60_000, () => {});

  assert.deepEqual(evicted, []);
});

test("remove() drops a session from both maps", () => {
  const store = createSessionStore<string>();
  store.sessions.set("s1", "transport-s1");
  store.lastActivity.set("s1", Date.now());

  store.remove("s1");

  assert.equal(store.sessions.has("s1"), false);
  assert.equal(store.lastActivity.has("s1"), false);
});
