// Bounded session lifecycle (S-14, docs/known-issues.md).
//
// Extracted out of index.ts's HTTP bootstrap so the sweep itself — "does
// an idle entry actually get reaped, does an active one survive" — can be
// unit-tested with a virtual clock instead of real timers and a real HTTP
// server.
//
// `lastActivity` is touched on every request that carries a known
// `Mcp-Session-Id` (index.ts), which is the only activity signal this
// server's usage pattern produces: tool calls are request/response, not
// server-initiated pushes, so "no request in `idleTimeoutMs`" and "client
// has gone away" are the same event here. A legitimately slow agent that
// takes long *between* tool calls but still calls back inside the idle
// window is unaffected — the window resets on every call, it isn't a
// session lifetime cap.
export interface SessionStore<T> {
  sessions: Map<string, T>;
  lastActivity: Map<string, number>;
  touch(id: string): void;
  remove(id: string): void;
}

export function createSessionStore<T>(): SessionStore<T> {
  const sessions = new Map<string, T>();
  const lastActivity = new Map<string, number>();
  return {
    sessions,
    lastActivity,
    touch(id: string) {
      lastActivity.set(id, Date.now());
    },
    remove(id: string) {
      sessions.delete(id);
      lastActivity.delete(id);
    },
  };
}

/** Evicts every session whose last activity is older than `idleTimeoutMs`
 * as of `now`, calling `onEvict(id)` for each (expected to close the
 * transport — removal from both maps is the caller's responsibility via
 * `transport.onclose`, same as before this module existed). Returns the
 * evicted ids, for tests. */
export function sweepIdleSessions<T>(
  store: Pick<SessionStore<T>, "lastActivity">,
  now: number,
  idleTimeoutMs: number,
  onEvict: (id: string) => void
): string[] {
  const evicted: string[] = [];
  for (const [id, last] of store.lastActivity) {
    if (now - last <= idleTimeoutMs) continue;
    evicted.push(id);
    onEvict(id);
  }
  return evicted;
}

/** Starts the recurring sweep. `.unref()`ed so it never holds the process
 * open by itself — there is no graceful-shutdown path in this server
 * (systemd just sends SIGTERM/SIGKILL on restart, same as every other
 * in-memory state here), so there is nothing to explicitly clear; an
 * unref'd interval is already inert at process exit, not a leak. */
export function startIdleSweep<T>(
  store: Pick<SessionStore<T>, "lastActivity">,
  intervalMs: number,
  idleTimeoutMs: number,
  onEvict: (id: string) => void
): NodeJS.Timeout {
  const timer = setInterval(() => sweepIdleSessions(store, Date.now(), idleTimeoutMs, onEvict), intervalMs);
  timer.unref();
  return timer;
}
