/**
 * Fake Scryfall API server — enough of https://api.scryfall.com for the search-results path
 * (`searchScryfall` + `transformScryfallResponse`) and the card-detail route to run offline.
 *
 * Point the app at it with `SCRYFALL_BASE_URL` (see `npm run dev:offline`) or start it inside a
 * test. It serves the cards in ./fixtures.ts.
 *
 * Supported:
 *   GET /cards/search?q=…&page=N&unique=cards|prints&order=name|released|cmc|usd&dir=asc|desc
 *     q supports implicit AND, "or" (binds looser than AND), parentheses, "-" negation of a
 *     term or a group, and double-quoted values. Unbalanced parentheses → 400, like Scryfall
 *     (error wording approximate) — which is what happens when the 1024-char cut lands inside
 *     a group.
 *       bare word / name:   name contains          t: / type:        type line contains
 *       o: / oracle:        oracle text contains   c: / color:       colors ⊇ (c= for exact)
 *       id: / identity:     color identity ⊆      s: / set: / e:    set code equals
 *       oracle_id:          equals                 game:             games includes
 *       date: / date= / date>= … (YYYY-MM-DD)      year: / year= …   release date comparisons
 *       is:alchemy|digital|rebalanced|dfc|split    prefer:oldest|newest  printing kept by unique=cards
 *                                                  (other prefer: values keep fixture order)
 *     order=released sorts by date, then set code, then collector number — the tie-break observed
 *     on the real API. prefer:oldest picks from the oldest date but, as observed on the real API,
 *     not the same printing: here it is the one with the highest collector number.
 *       fixture:400|404|429|429-long|500           forces that response (429 clears after one hit)
 *     Unknown keys are ignored rather than rejected, so any query shows something in the UI.
 *     Like Scryfall: `q` is silently cut to its first 1024 characters (logged when it happens);
 *     175 cards per page; no matches → 404 error object; a page past the end → 422 error object;
 *     `limit` is ignored — every lookup gets a full page (the wording of the 422 is approximate).
 *   GET /cards/:id          one fixture card
 *   GET /img/:id[/:face]/:size.svg   SVG placeholder so card images render offline
 *
 * Everything else answers a Scryfall-shaped 404. All requests are recorded in `requests`;
 * `failOnce()` makes the next matching request fail, to exercise fallback paths.
 *
 * Rate limits are enforced like Scryfall's: a token bucket per endpoint class — 2/s for
 * /cards/search, /cards/named, /cards/random and /cards/collection, 10/s for the rest of the API
 * (placeholder images are exempt; real card images come from a CDN). The search bucket's burst of
 * 15 is calibrated to a measurement against the real API: at 5 requests/s the 25th request was the
 * first 429. A 429 here carries no Retry-After, so the app's retry does not paper over it, and it
 * locks the whole API for `lockoutMs`: on the real API every request after the first 429 got one
 * too (the docs say 30 s, the response body said 60).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { FIXTURE_CARDS, type FixtureCard } from "./fixtures";

export const SCRYFALL_PAGE_SIZE = 175;
/** Scryfall truncates `q` to this many characters without warning. */
export const SCRYFALL_MAX_QUERY_CHARS = 1024;

export interface RecordedRequest {
  /** Date.now() when the request arrived. */
  at: number;
  method: string;
  /** Path and query string, e.g. `/cards/search?q=t%3Acreature&page=1`. */
  url: string;
  path: string;
  params: Record<string, string>;
  headers: Record<string, string>;
}

export type FailureMode = number | "disconnect";

export interface FakeScryfall {
  baseUrl: string;
  port: number;
  requests: RecordedRequest[];
  /** Clears recorded requests, one-shot failures and any lockout, and refills the rate-limit buckets (not the card list). */
  reset(): void;
  /** Swaps the served cards (default fixtures when omitted) — e.g. to set an exact result count. */
  setCards(cards?: readonly FixtureCard[]): void;
  /** The next request whose URL (raw or decoded) matches answers `how` (a status) or drops the connection. */
  failOnce(match: RegExp | string, how: FailureMode, retryAfterSeconds?: number): void;
  close(): Promise<void>;
}

export interface RateLimitOptions {
  /** Requests per second and burst for /cards/search|named|random|collection. */
  searchPerSecond?: number;
  searchBurst?: number;
  /** Requests per second and burst for every other API route. */
  otherPerSecond?: number;
  otherBurst?: number;
  /** How long a 429 keeps the whole API answering 429. */
  lockoutMs?: number;
}

export interface FakeScryfallOptions {
  port?: number;
  host?: string;
  /** Print one line per request. */
  log?: boolean;
  cards?: readonly FixtureCard[];
  /** Token-bucket limits (defaults below), or `false` to disable enforcement. */
  rateLimit?: RateLimitOptions | false;
}

export const DEFAULT_RATE_LIMIT: Required<RateLimitOptions> = {
  searchPerSecond: 2,
  searchBurst: 15,
  otherPerSecond: 10,
  otherBurst: 30,
  lockoutMs: 30_000,
};

const SEARCH_CLASS_RE = /^\/cards\/(search|named|random|collection)(\/|$)/;

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly perSecond: number, private readonly burst: number) {
    this.tokens = burst;
  }
  /** Takes a token if one is available. */
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
  refill(): void {
    this.tokens = this.burst;
    this.last = Date.now();
  }
}

const NOT_FOUND_DETAILS =
  "Your query didn’t match any cards. Adjust your search terms or refer to the syntax guide at https://scryfall.com/docs/reference";

function errorBody(status: number, code: string, details: string) {
  return { object: "error", code, status, details };
}

const COLOR_WORDS: Record<string, string> = {
  w: "W", white: "W", u: "U", blue: "U", b: "B", black: "B", r: "R", red: "R", g: "G", green: "G",
  c: "", colorless: "",
};

function colorSet(value: string): Set<string> | null {
  const lower = value.toLowerCase();
  if (lower in COLOR_WORDS) return new Set(COLOR_WORDS[lower] ? [COLOR_WORDS[lower]] : []);
  if (/^[wubrg]+$/.test(lower)) return new Set(lower.toUpperCase().split(""));
  return null;
}

interface Token {
  negated: boolean;
  key: string | null;
  op: string;
  value: string;
}

type Lexeme = { kind: "(" | ")" | "or" | "and"; negated?: boolean } | { kind: "term"; token: Token };

/** Splits q into terms, quoted phrases, parentheses and or/and keywords. */
function lex(q: string): Lexeme[] {
  const out: Lexeme[] = [];
  const re = /(-?)(?:(\()|(\))|(?:([a-z_]+)(:|=|>=|<=|>|<|!=))?(?:"([^"]*)"|([^\s()]+)))/gi;
  for (const m of q.matchAll(re)) {
    const negated = m[1] === "-";
    if (m[2]) out.push({ kind: "(", negated });
    else if (m[3]) out.push({ kind: ")" });
    else {
      const value = (m[6] ?? m[7] ?? "").trim();
      if (!value) continue;
      const word = value.toLowerCase();
      if (!m[4] && !negated && (word === "or" || word === "and")) out.push({ kind: word });
      else out.push({ kind: "term", token: { negated, key: m[4]?.toLowerCase() ?? null, op: m[5] ?? ":", value } });
    }
  }
  return out;
}

type Expr =
  | { kind: "term"; token: Token }
  | { kind: "and"; items: Expr[] }
  | { kind: "or"; items: Expr[] }
  | { kind: "not"; expr: Expr };

export class QuerySyntaxError extends Error {}

/** Recursive descent: or-expr := and-expr ("or" and-expr)*; and-expr := unary+ (optionally joined by "and"). */
function parse(lexemes: Lexeme[]): Expr {
  let i = 0;
  const peek = () => lexemes[i];
  const parseOr = (): Expr => {
    const items = [parseAnd()];
    while (peek()?.kind === "or") {
      i++;
      items.push(parseAnd());
    }
    return items.length === 1 ? items[0] : { kind: "or", items };
  };
  const parseAnd = (): Expr => {
    const items: Expr[] = [];
    for (;;) {
      const next = peek();
      if (!next || next.kind === ")" || next.kind === "or") break;
      if (next.kind === "and") {
        i++;
        continue;
      }
      items.push(parseUnary());
    }
    return items.length === 1 ? items[0] : { kind: "and", items };
  };
  const parseUnary = (): Expr => {
    const next = peek();
    if (next.kind === "(") {
      i++;
      const inner = parseOr();
      if (peek()?.kind !== ")") throw new QuerySyntaxError("unclosed parenthesis");
      i++;
      return next.negated ? { kind: "not", expr: inner } : inner;
    }
    if (next.kind === "term") {
      i++;
      const term: Expr = { kind: "term", token: { ...next.token, negated: false } };
      return next.token.negated ? { kind: "not", expr: term } : term;
    }
    throw new QuerySyntaxError(`unexpected ${next.kind}`);
  };
  const expr = parseOr();
  if (i < lexemes.length) throw new QuerySyntaxError("unbalanced parenthesis");
  return expr;
}

function evaluate(card: FixtureCard, expr: Expr): boolean {
  switch (expr.kind) {
    case "term": return matchesToken(card, expr.token);
    case "and": return expr.items.every((e) => evaluate(card, e));
    case "or": return expr.items.some((e) => evaluate(card, e));
    case "not": return !evaluate(card, expr.expr);
  }
}

function termsOf(expr: Expr): Token[] {
  switch (expr.kind) {
    case "term": return [expr.token];
    case "not": return termsOf(expr.expr);
    default: return expr.items.flatMap(termsOf);
  }
}

function oracleTextOf(card: FixtureCard): string {
  return [card.oracle_text, ...(card.card_faces ?? []).map((f) => f.oracle_text)].filter(Boolean).join("\n");
}

/** True when the card satisfies one (un-negated) token. Unknown keys match everything. */
function matchesToken(card: FixtureCard, t: Token): boolean {
  const v = t.value.toLowerCase();
  switch (t.key) {
    case "prefer":
    case "fixture":
      return true;
    case null:
    case "name":
      return card.name.toLowerCase().includes(v);
    case "t":
    case "type":
      return card.type_line.toLowerCase().includes(v);
    case "o":
    case "oracle":
      return oracleTextOf(card).toLowerCase().includes(v);
    case "c":
    case "color": {
      const want = colorSet(v);
      if (!want) return true;
      const have = new Set(card.colors);
      const superset = [...want].every((x) => have.has(x));
      return t.op === "=" ? superset && have.size === want.size : superset;
    }
    case "id":
    case "identity": {
      // Scryfall's default for identity is "fits within" (id:wbg finds mono-white too).
      const want = colorSet(v);
      if (!want) return true;
      const subset = card.color_identity.every((x) => want.has(x));
      return t.op === "=" ? subset && card.color_identity.length === want.size : subset;
    }
    case "s":
    case "set":
    case "e":
      return card.set.toLowerCase() === v;
    case "oracle_id":
      return card.oracle_id.toLowerCase() === v;
    case "date":
    case "year": {
      const have = t.key === "year" ? card.released_at.slice(0, 4) : card.released_at;
      switch (t.op) {
        case ">": return have > v;
        case ">=": return have >= v;
        case "<": return have < v;
        case "<=": return have <= v;
        case "!=": return have !== v;
        default: return have === v;
      }
    }
    case "game":
      return card.games.includes(v);
    case "is":
      switch (v) {
        case "alchemy": return card.set_type === "alchemy";
        case "digital": return card.digital;
        case "rebalanced": return card.name.startsWith("A-");
        case "dfc": return card.layout === "transform" || card.layout === "modal_dfc";
        case "split": return card.layout === "split";
        default: return true;
      }
    default:
      return true;
  }
}

const collectorNumber = (c: FixtureCard) => Number.parseInt(c.collector_number, 10) || 0;

/** Scryfall's observed ordering for same-day printings: set code, then collector number. */
function compareReleased(a: FixtureCard, b: FixtureCard): number {
  return (
    a.released_at.localeCompare(b.released_at) ||
    a.set.localeCompare(b.set) ||
    collectorNumber(a) - collectorNumber(b) ||
    a.collector_number.localeCompare(b.collector_number)
  );
}

const usdPrice = (c: FixtureCard): number | null => {
  const raw = c.prices?.usd;
  return raw == null ? null : Number(raw);
};

/**
 * order=cmc|usd: the direction flips only the value; ties always run by name A→Z, and cards with no
 * value (no USD price) come last in both directions. ASSUMPTION: the real API wasn't checked for
 * either detail offline.
 */
function compareByValue(value: (c: FixtureCard) => number | null, direction: 1 | -1) {
  return (a: FixtureCard, b: FixtureCard): number => {
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else if (va !== vb) {
      return (va - vb) * direction;
    }
    return a.name.localeCompare(b.name);
  };
}

/** One printing per oracle_id: the first in fixture order, or the oldest/newest under prefer:. */
function uniqueByOracle(cards: FixtureCard[], prefer: string | undefined): FixtureCard[] {
  // prefer:oldest takes the oldest date but, like the real API, not necessarily the printing that
  // order=released puts first: among same-day printings it takes the highest collector number.
  const better = (a: FixtureCard, b: FixtureCard) => {
    if (prefer === "oldest") {
      return b.released_at !== a.released_at
        ? b.released_at < a.released_at
        : collectorNumber(b) > collectorNumber(a) || (collectorNumber(b) === collectorNumber(a) && b.set > a.set);
    }
    return prefer === "newest" ? b.released_at > a.released_at : false;
  };
  const kept = new Map<string, FixtureCard>();
  for (const c of cards) {
    const current = kept.get(c.oracle_id);
    if (!current || better(current, c)) kept.set(c.oracle_id, c);
  }
  return [...kept.values()];
}

function absolutize(card: FixtureCard, baseUrl: string): FixtureCard {
  const abs = (uris?: Record<string, string>) =>
    uris && Object.fromEntries(Object.entries(uris).map(([k, u]) => [k, u.startsWith("/") ? baseUrl + u : u]));
  return {
    ...card,
    image_uris: abs(card.image_uris),
    card_faces: card.card_faces?.map((f) => ({ ...f, image_uris: abs(f.image_uris) })),
  };
}

function placeholderSvg(title: string, subtitle: string, size: string): string {
  const [w, h] = size === "small" ? [146, 204] : size === "large" ? [672, 936] : [488, 680];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const fs = Math.round(w / 14);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" rx="${w / 22}" fill="#2b2f3a"/>
  <rect x="${w * 0.06}" y="${h * 0.12}" width="${w * 0.88}" height="${h * 0.44}" rx="${w / 40}" fill="#3f4656"/>
  <text x="50%" y="${h * 0.08}" text-anchor="middle" fill="#e8e8e8" font-family="sans-serif" font-size="${fs}" font-weight="bold">${esc(title)}</text>
  <text x="50%" y="${h * 0.64}" text-anchor="middle" fill="#c0c4cc" font-family="sans-serif" font-size="${Math.round(fs * 0.8)}">${esc(subtitle)}</text>
  <text x="50%" y="${h * 0.94}" text-anchor="middle" fill="#8a90a0" font-family="sans-serif" font-size="${Math.round(fs * 0.7)}">fake scryfall fixture</text>
</svg>`;
}

export async function startFakeScryfall(options: FakeScryfallOptions = {}): Promise<FakeScryfall> {
  const host = options.host ?? "127.0.0.1";
  let cards = options.cards ?? FIXTURE_CARDS;
  let byId = new Map(cards.map((c) => [c.id, c]));
  const requests: RecordedRequest[] = [];
  const failures: Array<{ match: RegExp | string; how: FailureMode; retryAfterSeconds?: number }> = [];
  const rateLimitHits = new Set<string>();
  let lockedUntil = 0;
  const limits = options.rateLimit === false ? null : { ...DEFAULT_RATE_LIMIT, ...options.rateLimit };
  const buckets = limits && {
    search: new TokenBucket(limits.searchPerSecond, limits.searchBurst),
    other: new TokenBucket(limits.otherPerSecond, limits.otherBurst),
  };
  let baseUrl = "";

  const log = (line: string) => {
    if (options.log) console.log(`[fake-scryfall] ${line}`);
  };

  function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(json);
    return status;
  }

  function search(res: http.ServerResponse, params: URLSearchParams): string {
    const rawQ = params.get("q") ?? "";
    const q = rawQ.slice(0, SCRYFALL_MAX_QUERY_CHARS);
    if (rawQ.length > q.length) log(`q truncated from ${rawQ.length} to ${SCRYFALL_MAX_QUERY_CHARS} chars (Scryfall does this silently)`);
    const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
    const unique = params.get("unique") ?? "cards";
    const order = params.get("order") ?? "name";
    const dir = params.get("dir") ?? "asc";
    let expr: Expr;
    try {
      expr = parse(lex(q));
    } catch (error) {
      if (!(error instanceof QuerySyntaxError)) throw error;
      return `${send(res, 400, { ...errorBody(400, "bad_request", `Your query has an ${error.message}.`), warnings: [] })} bad request (${error.message})`;
    }
    const tokens = termsOf(expr);

    const scenario = tokens.find((t) => t.key === "fixture")?.value;
    if (scenario === "400") {
      return `${send(res, 400, { ...errorBody(400, "bad_request", "The fake Scryfall rejected this query (fixture:400)."), warnings: [] })} bad request`;
    }
    if (scenario === "404") return `${send(res, 404, errorBody(404, "not_found", NOT_FOUND_DETAILS))} not found`;
    if (scenario === "500") return `${send(res, 500, errorBody(500, "internal_error", "The fake Scryfall fell over (fixture:500)."))} server error`;
    if (scenario === "429-long" || (scenario === "429" && !rateLimitHits.has(q))) {
      rateLimitHits.add(q);
      const retryAfter = scenario === "429" ? "1" : "5";
      return `${send(res, 429, errorBody(429, "too_many_requests", "Rate limited (fixture)."), { "Retry-After": retryAfter })} rate limited, Retry-After ${retryAfter}`;
    }

    let matched = cards.filter((c) => evaluate(c, expr));
    if (unique !== "prints") matched = uniqueByOracle(matched, tokens.findLast((t) => t.key === "prefer")?.value.toLowerCase());
    if (order === "cmc" || order === "usd") {
      matched.sort(compareByValue(order === "cmc" ? (c) => c.cmc : usdPrice, dir === "desc" ? -1 : 1));
    } else {
      if (order === "released") matched.sort(compareReleased);
      else if (order === "name") matched.sort((a, b) => a.name.localeCompare(b.name));
      if (dir === "desc") matched.reverse();
    }

    if (matched.length === 0) return `${send(res, 404, errorBody(404, "not_found", NOT_FOUND_DETAILS))} no matches`;
    const start = (page - 1) * SCRYFALL_PAGE_SIZE;
    const data = matched.slice(start, start + SCRYFALL_PAGE_SIZE);
    if (data.length === 0) {
      return `${send(res, 422, errorBody(422, "validation_error", "You have paginated beyond the end of these results."))} page ${page} is past the end`;
    }

    const hasMore = start + data.length < matched.length;
    const next = new URLSearchParams(params);
    next.set("page", String(page + 1));
    send(res, 200, {
      object: "list",
      total_cards: matched.length,
      has_more: hasMore,
      ...(hasMore ? { next_page: `${baseUrl}/cards/search?${next}` } : {}),
      data: data.map((c) => absolutize(c, baseUrl)),
    });
    return `200 ${data.length} of ${matched.length} cards (page ${page}, unique=${unique})`;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", baseUrl);
    const params = Object.fromEntries(url.searchParams);
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")])
    );
    requests.push({ at: Date.now(), method: req.method ?? "GET", url: url.pathname + url.search, path: url.pathname, params, headers });

    const isImage = url.pathname.startsWith("/img/");
    if (buckets && !isImage) {
      const searchClass = SEARCH_CLASS_RE.test(url.pathname);
      const bucket = searchClass ? buckets.search : buckets.other;
      const lockedOut = Date.now() < lockedUntil;
      if (lockedOut || !bucket.take()) {
        if (!lockedOut) lockedUntil = Date.now() + limits.lockoutMs;
        const perSecond = searchClass ? limits.searchPerSecond : limits.otherPerSecond;
        send(res, 429, errorBody(429, "too_many_requests", `You have exceeded the rate limit of ${perSecond} requests per second for this endpoint. Slow down or your access will be revoked.`));
        log(`${req.method} ${decodeURIComponent(url.pathname + url.search)} -> 429 RATE LIMIT (fake enforces ${perSecond}/s on ${searchClass ? "search-class" : "other"} routes)`);
        return;
      }
    }

    // Match against the decoded URL as well, so `oracle_id:` reads naturally in tests.
    const candidates = [url.toString(), decodeURIComponent(url.toString().replace(/\+/g, " "))];
    const failure = failures.findIndex((f) =>
      candidates.some((u) => (typeof f.match === "string" ? u.includes(f.match) : f.match.test(u)))
    );
    if (failure !== -1) {
      const [{ how, retryAfterSeconds }] = failures.splice(failure, 1);
      if (how === "disconnect") {
        log(`${req.method} ${url.pathname}${url.search} -> connection dropped (failOnce)`);
        req.socket.destroy();
        return;
      }
      const failureHeaders: Record<string, string> = retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {};
      send(res, how, errorBody(how, "fixture_failure", `Injected failure (${how}).`), failureHeaders);
      log(`${req.method} ${url.pathname}${url.search} -> ${how} (failOnce)`);
      return;
    }

    let outcome: string;
    const image = url.pathname.match(/^\/img\/([^/]+)(?:\/(\d+))?\/(small|normal|large)\.svg$/);
    if (url.pathname === "/cards/search") {
      outcome = search(res, url.searchParams);
    } else if (url.pathname.startsWith("/cards/")) {
      const card = byId.get(url.pathname.slice("/cards/".length));
      outcome = card
        ? `${send(res, 200, absolutize(card, baseUrl))} ${card.name}`
        : `${send(res, 404, errorBody(404, "not_found", "No card found with the given ID"))} no such card`;
    } else if (image) {
      const card = byId.get(image[1]);
      const face = image[2] !== undefined ? card?.card_faces?.[Number(image[2])] : undefined;
      const title = face?.name ?? card?.name ?? "Unknown card";
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
      res.end(placeholderSvg(title, card ? `${card.set_name} · #${card.collector_number}` : "", image[3]));
      outcome = `200 placeholder for ${title}`;
    } else {
      outcome = `${send(res, 404, errorBody(404, "not_found", "The requested object or REST method was not found."))} unknown route`;
    }
    log(`${req.method} ${decodeURIComponent(url.pathname + url.search)} -> ${outcome}`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://${host}:${port}`;

  return {
    baseUrl,
    port,
    requests,
    reset() {
      requests.length = 0;
      failures.length = 0;
      rateLimitHits.clear();
      lockedUntil = 0;
      buckets?.search.refill();
      buckets?.other.refill();
    },
    setCards(list) {
      cards = list ?? FIXTURE_CARDS;
      byId = new Map(cards.map((c) => [c.id, c]));
    },
    failOnce(match, how, retryAfterSeconds) {
      failures.push({ match, how, retryAfterSeconds });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
