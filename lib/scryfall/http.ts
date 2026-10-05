export const SCRYFALL_BASE_URL = "https://api.scryfall.com";
export const SCRYFALL_USER_AGENT =
  process.env.SCRYFALL_USER_AGENT || "find-that-card/1.0 (+https://findthatcard.net)";

const TIMEOUT_MS = 10_000;
const MAX_RETRY_WAIT_MS = 2_000;
// Scryfall asks for 50–100 ms between requests (~10/s) and answers bursts with a 429 that warns
// access will be revoked if ignored.
const MIN_SPACING_MS = 100;

// ponytail: per-instance spacing — N warm instances can together exceed 10/s. Upgrade path: a
// shared token bucket (Upstash/Vercel KV) if traffic ever gets there.
let nextSlot = 0;
function waitForSlot(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_SPACING_MS;
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}

/**
 * fetch() for Scryfall-run hosts (api, tagger, docs) and the MTG Wiki: sets the User-Agent and
 * Accept headers Scryfall requires (callers may override), spaces requests ≥100 ms apart, aborts
 * after 10s so a hung upstream can't pin a serverless invocation, and retries a 429 once — only
 * when its Retry-After asks for ≤2s. A longer (or unstated) back-off is returned to the caller
 * as-is: retrying early is exactly what Scryfall warns against.
 */
export async function scryfallFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", SCRYFALL_USER_AGENT);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  for (let attempt = 0; ; attempt++) {
    await waitForSlot();
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetch(url, { ...init, headers, signal });
    if (response.status !== 429 || attempt > 0) return response;
    const retryAfterMs = Number(response.headers.get("Retry-After")) * 1000;
    if (!(retryAfterMs > 0 && retryAfterMs <= MAX_RETRY_WAIT_MS)) return response;
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
  }
}
