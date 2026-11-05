// Overridable so tests and `npm run dev:offline` can point the app at a local fake Scryfall.
export const SCRYFALL_BASE_URL =
  process.env.SCRYFALL_BASE_URL?.replace(/\/+$/, "") || "https://api.scryfall.com";
export const SCRYFALL_USER_AGENT =
  process.env.SCRYFALL_USER_AGENT || "find-that-card/1.0 (+https://findthatcard.net)";

const TIMEOUT_MS = 10_000;
const MAX_RETRY_WAIT_MS = 2_000;
// Scryfall's limits (https://scryfall.com/docs/api): 10 requests/s overall, and 2 requests/s for
// /cards/search, /cards/named, /cards/random and /cards/collection. Bursts get a 429 that warns
// access will be revoked if ignored.
const MIN_SPACING_MS = 100;
const SEARCH_SPACING_MS = 500;
const SEARCH_CLASS_RE = /^\/cards\/(search|named|random|collection)(\/|$)/;
// A 429 locks the API for a while and hammering it risks a ban: the docs say 30 s, the 429 body
// seen in practice said 60. Used when the response has no Retry-After.
const DEFAULT_LOCKOUT_MS = 60_000;

function isSearchClassUrl(url: string): boolean {
  try {
    return SEARCH_CLASS_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isScryfallApi(url: string): boolean {
  return url.startsWith(SCRYFALL_BASE_URL) || url.startsWith("https://api.scryfall.com");
}

// ponytail: per-instance spacing and lockout — N warm instances can together exceed the limits, and
// each has to hit its own 429. Upgrade path: a shared token bucket (Upstash/Vercel KV) if traffic
// ever gets there.
let lockedUntil = 0;
let nextSlot = 0;
let nextSearchSlot = 0;
let lastSentAt = -Infinity;
let lastSearchSentAt = -Infinity;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for this request's turn: every request is ≥100 ms after the previous one, and a search-class
 * request is also ≥500 ms after the previous search-class one.
 *
 * Slots are reserved up front so concurrent callers queue in order. A timer can fire late, though
 * (busy event loop, GC), and then the previous request went out later than its slot; so after the
 * slot, the spacing is also waited out from when the previous request was actually sent.
 */
async function waitForSlot(searchClass: boolean): Promise<void> {
  const now = Date.now();
  let at = Math.max(now, nextSlot);
  if (searchClass) at = Math.max(at, nextSearchSlot);
  nextSlot = at + MIN_SPACING_MS;
  if (searchClass) nextSearchSlot = at + SEARCH_SPACING_MS;
  if (at > now) await sleep(at - now);
  for (;;) {
    let ready = lastSentAt + MIN_SPACING_MS;
    if (searchClass) ready = Math.max(ready, lastSearchSentAt + SEARCH_SPACING_MS);
    const wait = ready - Date.now();
    if (wait <= 0) return;
    await sleep(wait);
  }
}

/** Called right after handing a request to fetch(), so any timestamp taken inside fetch is ≤ this mark. */
function markSent(searchClass: boolean): void {
  lastSentAt = Date.now();
  if (searchClass) lastSearchSentAt = lastSentAt;
}

/** What the API would answer during a lockout, without sending it another request. */
function lockedOutResponse(): Response {
  const details = "Not sent: Scryfall rate limited this app and the lockout has not passed yet.";
  return new Response(JSON.stringify({ object: "error", code: "too_many_requests", status: 429, details }), {
    status: 429,
    headers: { "Retry-After": String(Math.ceil((lockedUntil - Date.now()) / 1000)) },
  });
}

/**
 * fetch() for Scryfall-run hosts (api, tagger, docs) and the MTG Wiki: sets the User-Agent and
 * Accept headers Scryfall requires (callers may override), paces requests to Scryfall's limits
 * (≥100 ms apart, ≥500 ms between search-class requests), aborts after 10s so a hung upstream
 * can't pin a serverless invocation, and retries a 429 once — only when its Retry-After asks for
 * ≤2s. A longer (or unstated) back-off is returned to the caller as-is, and until it has passed
 * every API call gets that same 429 back without touching the network: retrying early is exactly
 * what Scryfall warns against.
 */
export async function scryfallFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", SCRYFALL_USER_AGENT);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  const searchClass = isSearchClassUrl(url);
  const scryfallApi = isScryfallApi(url);
  for (let attempt = 0; ; attempt++) {
    await waitForSlot(searchClass);
    // Checked after the wait: a request queued behind the one that got the 429 must not go out.
    if (scryfallApi && Date.now() < lockedUntil) return lockedOutResponse();
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const pending = fetch(url, { ...init, headers, signal });
    markSent(searchClass);
    const response = await pending;
    if (response.status !== 429) return response;
    const retryAfterMs = Number(response.headers.get("Retry-After")) * 1000;
    if (attempt === 0 && retryAfterMs > 0 && retryAfterMs <= MAX_RETRY_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      continue;
    }
    if (scryfallApi) lockedUntil = Date.now() + (retryAfterMs > 0 ? retryAfterMs : DEFAULT_LOCKOUT_MS);
    return response;
  }
}
