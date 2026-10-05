/**
 * Fixed-window request limiter keyed by client (IP).
 *
 * ponytail: in-memory and per serverless instance — the effective ceiling is `limit` × live
 * instances, and a cold instance starts with a clean slate. Enough to stop one client from
 * looping the AI endpoint; upgrade path is a shared store (Upstash/Vercel KV) or a Vercel
 * Firewall rate-limit rule if abuse spans instances.
 */
export function createRateLimiter(limit: number, windowMs: number) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  /** Returns seconds until the client may retry, or 0 when the request is allowed. */
  return (key: string, now = Date.now()): number => {
    const entry = windows.get(key);
    if (!entry || now >= entry.resetAt) {
      // Prune expired windows lazily so the map can't grow without bound.
      if (windows.size >= 10_000) {
        for (const [k, w] of windows) if (now >= w.resetAt) windows.delete(k);
      }
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return 0;
    }
    entry.count += 1;
    return entry.count > limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  };
}

/** Client IP behind Vercel's proxy (which sets x-forwarded-for / x-real-ip). */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    headers.get("x-real-ip") ||
    "unknown"
  );
}
