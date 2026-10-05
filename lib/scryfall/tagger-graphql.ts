import { scryfallFetch } from "@/lib/scryfall/http";

const TAGGER_BASE = "https://tagger.scryfall.com";
const SESSION_TTL_MS = 10 * 60_000;

type TaggerSession = {
  csrfToken: string;
  cookies: string;
};

// One session serves every lookup for SESSION_TTL_MS instead of scraping the homepage per card.
let cachedSession: { session: Promise<TaggerSession | null>; expiresAt: number } | null = null;

function getTaggerSession(): Promise<TaggerSession | null> {
  if (!cachedSession || Date.now() >= cachedSession.expiresAt) {
    const session = fetchTaggerSession();
    cachedSession = { session, expiresAt: Date.now() + SESSION_TTL_MS };
    // A failed fetch isn't kept — the next lookup tries again.
    void session.then((s) => {
      if (!s && cachedSession?.session === session) cachedSession = null;
    });
  }
  return cachedSession.session;
}

/**
 * Fetches a CSRF token + session cookies from the Tagger SPA.
 * The token is extracted from a `<meta name="csrf-token">` tag embedded in
 * every Tagger HTML page. The session cookie is required for the GraphQL
 * endpoint to accept the token.
 */
async function fetchTaggerSession(): Promise<TaggerSession | null> {
  try {
    const res = await scryfallFetch(`${TAGGER_BASE}/`, {
      headers: { Accept: "text/html" },
      redirect: "follow",
    });
    if (!res.ok) return null;

    const html = await res.text();
    const tokenMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/);
    if (!tokenMatch) return null;

    const setCookies = res.headers.getSetCookie?.() ?? [];
    const cookies = setCookies
      .map((c) => c.split(";")[0])
      .join("; ");

    return { csrfToken: tokenMatch[1], cookies };
  } catch (err) {
    console.warn("[Tagger GQL] Failed to obtain session:", err);
    return null;
  }
}

type TaggerTagging = {
  tag: { name: string; type: string; namespace: string };
  type: string;
  foreignKey: string;
};

type TaggerRelationship = {
  classifier: string;
  subjectName: string;
  relatedName: string;
  status: string;
};

export type TaggerCardData = {
  name: string;
  oracleId: string;
  /** Oracle/function tags (ORACLE_CARD_TAG only, not artwork tags). */
  functionTags: string[];
  /** Artwork/illustration tags (ILLUSTRATION_TAG) for the card's art. */
  artTags: string[];
  /** Card names from SIMILAR_TO relationships. */
  similarTo: string[];
  /** Card names from BETTER_THAN relationships (cards this card is better than). */
  betterThan: string[];
  /** Card names from WORSE_THAN relationships (cards that are worse than this card, i.e. alternatives). */
  worseThan: string[];
  /** Card names from WITHOUT_BODY relationships. */
  withoutBody: string[];
};

const CARD_QUERY = `
  query FetchCardBySet($set: String!, $number: String!) {
    cardBySet(set: $set, number: $number) {
      id name oracleId
      taggings {
        tag { name type namespace }
        type foreignKey
      }
      relationships {
        classifier subjectName relatedName status
      }
    }
  }
`;

/**
 * Fetches a card's community-curated tags and relationships from the Scryfall
 * Tagger GraphQL API.
 *
 * Requires two HTTP calls: one to obtain a CSRF session token and one for the
 * actual GraphQL query. Returns null if any step fails.
 */
export async function fetchTaggerCardData(
  setCode: string,
  collectorNumber: string
): Promise<TaggerCardData | null> {
  const session = await getTaggerSession();
  if (!session) return null;

  try {
    const res = await scryfallFetch(`${TAGGER_BASE}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrfToken,
        Cookie: session.cookies,
      },
      body: JSON.stringify({
        query: CARD_QUERY,
        variables: { set: setCode, number: collectorNumber },
      }),
    });

    if (!res.ok) {
      console.warn(`[Tagger GQL] GraphQL request failed: ${res.status}`);
      cachedSession = null; // the session may have expired upstream — refresh on the next lookup
      return null;
    }

    const json = (await res.json()) as {
      data?: {
        cardBySet?: {
          name: string;
          oracleId: string;
          taggings: TaggerTagging[];
          relationships: TaggerRelationship[];
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      console.warn("[Tagger GQL] GraphQL errors:", json.errors);
      return null;
    }

    const card = json.data?.cardBySet;
    if (!card) return null;

    const functionTags = card.taggings
      .filter((t) => t.tag.type === "ORACLE_CARD_TAG")
      .map((t) => (t.tag.name as string).toLowerCase().replace(/\s+/g, "-"));

    const artTags = card.taggings
      .filter((t) => t.tag.type === "ILLUSTRATION_TAG")
      .map((t) => (t.tag.name as string).toLowerCase().replace(/\s+/g, "-"));

    // Relationships are directed edges: subjectName → relatedName.
    // Extract the "other" card's name — the side that isn't the queried card.
    // Skip entries where neither side matches (transitive noise).
    const relsByClassifier = (classifier: string): string[] => {
      const names: string[] = [];
      for (const r of card.relationships) {
        if (r.classifier !== classifier || r.status !== "GOOD_STANDING") continue;
        if (r.subjectName === card.name && r.relatedName !== card.name) {
          names.push(r.relatedName);
        } else if (r.relatedName === card.name && r.subjectName !== card.name) {
          names.push(r.subjectName);
        }
      }
      return [...new Set(names)];
    };

    return {
      name: card.name,
      oracleId: card.oracleId,
      functionTags,
      artTags,
      similarTo: relsByClassifier("SIMILAR_TO"),
      betterThan: relsByClassifier("BETTER_THAN"),
      worseThan: relsByClassifier("WORSE_THAN"),
      withoutBody: relsByClassifier("WITHOUT_BODY"),
    };
  } catch (err) {
    console.warn("[Tagger GQL] Request failed:", err);
    return null;
  }
}
