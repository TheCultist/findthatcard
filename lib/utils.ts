import { SearchResponse, CardResult, ScryfallCard } from "@/types/scryfall";

const MAX_QUERY_LENGTH = 400;

/**
 * In-memory cache for Scryfall Tagger tags
 * Structure: Map<'art' | 'function', Set<string>>
 */
let taggerTagCache: Map<'art' | 'function', Set<string>> | null = null;
let cacheInitializationPromise: Promise<void> | null = null;

export type TaggerTagContext = {
  art: string[];
  function: string[];
};

/**
 * Fetches and parses the Scryfall Tagger Tags documentation page
 * Extracts all valid art: and function: tags
 */
async function initializeTaggerTagCache(): Promise<void> {
  if (taggerTagCache !== null) {
    return; // Cache already initialized
  }

  const artTags = new Set<string>();
  const functionTags = new Set<string>();
  const artOperators = new Set<string>(['art', 'atag', 'arttag']);
  const functionOperators = new Set<string>(['function', 'otag', 'oracletag']);

  try {
    const response = await fetch('https://scryfall.com/docs/tagger-tags', {
      headers: {
        'User-Agent': 'find-that-card/1.0 (+https://findthat.card)',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch tagger tags: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();

    /**
     * Decodes HTML entities iteratively to handle double-encoding (e.g., &amp;amp; -> &amp; -> &)
     * Continues until no more changes occur
     */
    function decodeHtmlEntities(text: string): string {
      let previous = text;
      let current = text;
      
      // Keep decoding until no more changes occur
      do {
        previous = current;
        current = previous
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
      } while (current !== previous);
      
      return current;
    }

    function decodeTagName(rawTag: string): string {
      try {
        return decodeURIComponent(rawTag.trim());
      } catch {
        return rawTag.trim();
      }
    }

    function extractTagFromQuery(
      queryParam: string,
      hasArtMarker: boolean
    ): { type: 'art' | 'function'; tagName: string } | null {
      const decodedQuery = decodeHtmlEntities(queryParam).trim();
      const operatorMatch = decodedQuery.match(/^([a-z]+):(.+)$/i);

      if (!operatorMatch) {
        return null;
      }

      const operator = operatorMatch[1].toLowerCase();
      const rawTag = operatorMatch[2];

      let tagType: 'art' | 'function';
      if (hasArtMarker || artOperators.has(operator)) {
        tagType = 'art';
        artOperators.add(operator);
      } else {
        tagType = 'function';
        functionOperators.add(operator);
      }

      const tagName = decodeTagName(rawTag);
      if (!tagName) {
        return null;
      }

      return { type: tagType, tagName };
    }

    // Parse content to extract tags from any search links
    const hrefPattern = /href=["']([^"']+)["']/gi;

    let match;

    while ((match = hrefPattern.exec(html)) !== null) {
      const decodedHref = decodeHtmlEntities(match[1]);
      if (!decodedHref.includes('/search')) {
        continue;
      }

      let url: URL;
      try {
        url = new URL(decodedHref, 'https://scryfall.com');
      } catch {
        continue;
      }

      if (!url.pathname.includes('/search')) {
        continue;
      }

      const q = url.searchParams.get('q');
      if (!q) {
        continue;
      }

      const hasArtMarker = url.searchParams.get('unique') === 'art';
      const extractedTag = extractTagFromQuery(q, hasArtMarker);

      if (!extractedTag) {
        continue;
      }

      if (extractedTag.type === 'art') {
        artTags.add(extractedTag.tagName);
      } else {
        functionTags.add(extractedTag.tagName);
      }
    }

    taggerTagCache = new Map([
      ['art', artTags],
      ['function', functionTags],
    ]);

    console.log(`[Tagger Cache] Initialized with ${artTags.size} art tags and ${functionTags.size} function tags`);
  } catch (error) {
    console.error('[Tagger Cache] Failed to initialize cache:', error);
    // Initialize with empty sets to prevent repeated failed attempts
    // This allows the app to continue functioning, but all tags will be assumed valid
    taggerTagCache = new Map([
      ['art', new Set()],
      ['function', new Set()],
    ]);
    // Don't throw - allow the app to continue with empty cache (tags will be assumed valid)
  }
}

/**
 * Ensures the tagger tag cache is initialized
 * Uses a promise to prevent concurrent initialization attempts
 */
async function ensureTaggerTagCache(): Promise<void> {
  if (taggerTagCache !== null) {
    return;
  }

  if (cacheInitializationPromise === null) {
    cacheInitializationPromise = initializeTaggerTagCache().catch((error) => {
      // Reset promise on error so we can retry
      cacheInitializationPromise = null;
      throw error;
    });
  }

  await cacheInitializationPromise;
}

function extractTaggerKeywords(naturalQuery: string): string[] {
  const stopwords = new Set([
    'a', 'an', 'the', 'and', 'or', 'with', 'without', 'for', 'to', 'in', 'on', 'of',
    'from', 'by', 'about', 'that', 'those', 'these', 'this', 'cards', 'card',
    'synergy', 'synergies', 'package', 'packages', 'commander', 'edh', 'format',
    'spells', 'spell', 'creature', 'creatures', 'deck', 'decks'
  ]);

  const words = naturalQuery.toLowerCase().match(/[a-z0-9-]+/g) || [];
  const keywords = new Set<string>();

  for (const word of words) {
    if (word.length < 3 || stopwords.has(word)) {
      continue;
    }
    keywords.add(word);
  }

  return Array.from(keywords);
}

function scoreTagMatch(tag: string, keywords: string[]): number {
  if (keywords.length === 0) {
    return 0;
  }

  const tokens = tag.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;

  for (const keyword of keywords) {
    if (keyword.length < 3) {
      continue;
    }

    let matched = false;
    for (const token of tokens) {
      if (token.length < 3) {
        continue;
      }

      if (token === keyword) {
        score += 2;
        matched = true;
        break;
      }

      if (token.includes(keyword) || keyword.includes(token)) {
        score += 1;
        matched = true;
        break;
      }
    }

    if (matched) {
      continue;
    }

    if (tag.toLowerCase().includes(keyword)) {
      score += 1;
    }
  }

  return score;
}

/**
 * Returns a narrowed list of Tagger tags relevant to the query.
 * Used to guide the model toward valid tags without sending the full catalog.
 */
export async function getTaggerTagContext(
  naturalQuery: string,
  maxPerType: number = 40
): Promise<TaggerTagContext> {
  await ensureTaggerTagCache();

  if (taggerTagCache === null) {
    return { art: [], function: [] };
  }

  const keywords = extractTaggerKeywords(naturalQuery);
  if (keywords.length === 0) {
    return { art: [], function: [] };
  }

  const buildList = (type: 'art' | 'function'): string[] => {
    const tagSet = taggerTagCache?.get(type);
    if (!tagSet) {
      return [];
    }

    const scored = Array.from(tagSet)
      .map((tag) => ({ tag, score: scoreTagMatch(tag, keywords) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => (b.score - a.score) || a.tag.localeCompare(b.tag))
      .slice(0, maxPerType)
      .map((entry) => entry.tag);

    return scored;
  };

  return {
    art: buildList('art'),
    function: buildList('function'),
  };
}

/**
 * Validates natural language query input
 */
export function validateNaturalQuery(query: string): { valid: boolean; error?: string } {
  if (!query || typeof query !== "string") {
    return { valid: false, error: "Query is required" };
  }

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "Query cannot be empty" };
  }

  if (trimmed.length > MAX_QUERY_LENGTH) {
    return {
      valid: false,
      error: `Query must be ${MAX_QUERY_LENGTH} characters or less`,
    };
  }

  return { valid: true };
}

const CARDS_PER_PAGE = 60;

/**
 * Trims Scryfall response to only include necessary fields
 */
export async function transformScryfallResponse(
  scryfallQuery: string,
  page: number,
  offset: number,
  scryfallResponse: {
    total_cards: number;
    has_more: boolean;
    data: ScryfallCard[];
  }
): Promise<SearchResponse> {
  // Check if query explicitly asks for alchemy/arena cards
  const queryLower = scryfallQuery.toLowerCase();
  const explicitlyAsksForAlchemy = queryLower.includes('is:alchemy') || queryLower.includes('game:arena');
  
  // Slice the data starting from the offset, taking up to 60 cards
  const slicedData = scryfallResponse.data.slice(offset, offset + CARDS_PER_PAGE);
  
  const getImageUris = (card: ScryfallCard) => {
    if (card.image_uris) {
      return card.image_uris;
    }

    const firstFaceWithImage = card.card_faces?.find((face) => face.image_uris);
    return firstFaceWithImage?.image_uris;
  };

  const cardResults = await Promise.all(
    slicedData.map(async (card): Promise<CardResult | null> => {
      // Check if this card is an alchemy card
      const isAlchemy = card.set_name?.toLowerCase().includes("alchemy") || 
                        card.set_type?.toLowerCase() === "alchemy";
      
      // If card is alchemy and query doesn't explicitly ask for alchemy, replace with non-alchemy version
      if (isAlchemy && !explicitlyAsksForAlchemy && card.oracle_id) {
        try {
          // Fetch a non-alchemy print of this card using oracle_id
          const baseCardResponse = await fetch(
            `https://api.scryfall.com/cards/search?q=prefer:best+oracle_id:${card.oracle_id}+-is:alchemy+-is:digital+-is:rebalanced&unique=prints&order=released&dir=asc&limit=1`,
            {
              headers: {
                'User-Agent': process.env.SCRYFALL_USER_AGENT || 'find-that-card/1.0 (+https://findthat.card)',
              },
            }
          );
          
          if (baseCardResponse.ok) {
            const baseCardData = await baseCardResponse.json();
            if (baseCardData.data && baseCardData.data.length > 0) {
              // Replace the alchemy card with the non-alchemy version
              const basePrint = baseCardData.data[0];
              // Use the non-alchemy card's data instead
              card = basePrint as ScryfallCard;
            } else {
              // No non-alchemy version found - exclude this card by returning null
              return null;
            }
          } else {
            // If search fails, try alternative: get all prints and filter client-side
            const printsResponse = await fetch(
              `https://api.scryfall.com/cards/search?q=prefer:best+oracle_id:${card.oracle_id}&unique=prints&order=released&dir=asc`,
              {
                headers: {
                  'User-Agent': process.env.SCRYFALL_USER_AGENT || 'find-that-card/1.0 (+https://findthat.card)',
                },
              }
            );
            
            if (printsResponse.ok) {
              const printsData = await printsResponse.json();
              // Find the first non-alchemy, non-digital, non-rebalanced print
              const basePrint = printsData.data?.find((print: any) => {
                const printSetName = (print.set_name || "").toLowerCase();
                const printSetType = (print.set_type || "").toLowerCase();
                const printIsDigital = print.digital === true;
                return !printSetName.includes("alchemy") && 
                       printSetType !== "alchemy" &&
                       !printIsDigital;
              });
              
              if (basePrint) {
                // Replace with non-alchemy version
                card = basePrint as ScryfallCard;
              } else {
                // No non-alchemy version found - exclude this card
                return null;
              }
            } else {
              // If we can't fetch prints, exclude the alchemy card
              return null;
            }
          }
        } catch (error) {
          // If fetching fails, exclude the alchemy card
          console.warn(`Failed to fetch non-alchemy version for ${card.name}, excluding from results:`, error);
          return null;
        }
      }
      
      // Now process the card (which may have been replaced with a non-alchemy version)
      const imageUris = getImageUris(card);
      
      // For split cards and other multi-faced cards, prioritize card_faces mana costs
      let manaCost = card.mana_cost;
      if (card.card_faces && card.card_faces.length > 0) {
        // Get mana cost from all faces, separated by slash for split cards
        const faceManaCosts = card.card_faces
          .map(face => face.mana_cost)
          .filter((cost): cost is string => !!cost);
        if (faceManaCosts.length > 0) {
          // Join with " / " to separate the costs visually
          // This ensures split cards show separate costs instead of combined
          manaCost = faceManaCosts.join(" / ");
        }
      }
      
      // For alchemy cards when explicitly requested, fetch the base card name for CardTrader links
      // Also check if set is digital/online-only and find a non-digital set
      let cardName = card.name;
      let setName = card.set_name || null;
      let setType = card.set_type || null;
      
      // If card name starts with "A-", check all_parts for a non-A- version
      if (cardName.startsWith("A-") && card.all_parts && card.all_parts.length > 0) {
        // Look for a related card that doesn't start with "A-"
        const baseCardPart = card.all_parts.find(part => !part.name.startsWith("A-"));
        if (baseCardPart) {
          cardName = baseCardPart.name;
        }
      }
      
      // Re-check if card is alchemy (it might have been replaced above)
      const cardIsAlchemy = card.set_name?.toLowerCase().includes("alchemy") || 
                            card.set_type?.toLowerCase() === "alchemy";
      const isDigital = card.digital === true;
      
      if (cardIsAlchemy && card.oracle_id) {
        // Handle alchemy cards - fetch base card name for CardTrader links
        try {
          // Fetch a non-alchemy print of this card using oracle_id
          const baseCardResponse = await fetch(
            `https://api.scryfall.com/cards/search?q=prefer:best+oracle_id:${card.oracle_id}+-is:alchemy+-is:digital+-is:rebalanced&unique=prints&order=released&dir=asc&limit=1`,
            {
              headers: {
                'User-Agent': process.env.SCRYFALL_USER_AGENT || 'find-that-card/1.0 (+https://findthat.card)',
              },
            }
          );
          
          if (baseCardResponse.ok) {
            const baseCardData = await baseCardResponse.json();
            if (baseCardData.data && baseCardData.data.length > 0) {
              const basePrint = baseCardData.data[0];
              // Use the first non-alchemy print's name (this should be the base card name)
              cardName = basePrint.name;
            }
          } else {
            // If search fails, try alternative: get all prints and filter client-side
            const printsResponse = await fetch(
              `https://api.scryfall.com/cards/search?q=prefer:best+oracle_id:${card.oracle_id}&unique=prints&order=released&dir=asc`,
              {
                headers: {
                  'User-Agent': process.env.SCRYFALL_USER_AGENT || 'find-that-card/1.0 (+https://findthat.card)',
                },
              }
            );
            
            if (printsResponse.ok) {
              const printsData = await printsResponse.json();
              // Find the first non-alchemy, non-digital, non-rebalanced print
              const basePrint = printsData.data?.find((print: any) => {
                const printSetName = (print.set_name || "").toLowerCase();
                const printSetType = (print.set_type || "").toLowerCase();
                const printIsDigital = print.digital === true;
                return !printSetName.includes("alchemy") && 
                       printSetType !== "alchemy" &&
                       !printIsDigital;
              });
              
              if (basePrint) {
                // Use the base print's name if this is an alchemy card
                cardName = basePrint.name;
              }
            }
          }
        } catch (error) {
          // If fetching fails, fall back to using the alchemy card name
          console.warn(`Failed to fetch base card name for alchemy card ${card.name}:`, error);
        }
      } else if (isDigital && card.oracle_id) {
        // Handle digital-only cards (non-alchemy) - find a non-digital set
        try {
          // Fetch a non-digital print of this card using oracle_id
          const baseCardResponse = await fetch(
            `https://api.scryfall.com/cards/search?q=prefer:best+oracle_id:${card.oracle_id}+-is:digital+-is:alchemy+-is:rebalanced&unique=prints&order=released&dir=asc&limit=1`,
            {
              headers: {
                'User-Agent': process.env.SCRYFALL_USER_AGENT || 'find-that-card/1.0 (+https://findthat.card)',
              },
            }
          );
          
          if (baseCardResponse.ok) {
            const baseCardData = await baseCardResponse.json();
            if (baseCardData.data && baseCardData.data.length > 0) {
              const basePrint = baseCardData.data[0];
              // Update set name and type to use non-digital set
              setName = basePrint.set_name || setName;
              setType = basePrint.set_type || setType;
            }
          } else {
            // If search fails, try alternative: get all prints and filter client-side
            const printsResponse = await fetch(
              `https://api.scryfall.com/cards/search?q=prefer:best+oracle_id:${card.oracle_id}&unique=prints&order=released&dir=asc`,
              {
                headers: {
                  'User-Agent': process.env.SCRYFALL_USER_AGENT || 'find-that-card/1.0 (+https://findthat.card)',
                },
              }
            );
            
            if (printsResponse.ok) {
              const printsData = await printsResponse.json();
              // Find the first non-digital, non-alchemy, non-rebalanced print
              const basePrint = printsData.data?.find((print: any) => {
                const printSetName = (print.set_name || "").toLowerCase();
                const printSetType = (print.set_type || "").toLowerCase();
                const printIsDigital = print.digital === true;
                return !printIsDigital &&
                       !printSetName.includes("alchemy") && 
                       printSetType !== "alchemy";
              });
              
              if (basePrint) {
                // Update set name and type to use non-digital set
                setName = basePrint.set_name || setName;
                setType = basePrint.set_type || setType;
              }
            }
          }
        } catch (error) {
          // If fetching fails, fall back to using the digital set name
          console.warn(`Failed to fetch non-digital set for card ${card.name}:`, error);
        }
      }


      return {
        id: card.id,
        name: cardName, // Use base name for alchemy cards, original name otherwise
        mana_cost: manaCost || null,
        type_line: card.type_line,
        oracle_text: card.oracle_text || null,
        image_uris: {
          normal: imageUris?.normal || imageUris?.large || null,
          small: imageUris?.small || null, // Fallback
        },
        scryfall_uri: card.scryfall_uri,
        set_name: setName, // Use non-digital set name if card was digital-only
        set_type: setType, // Use non-digital set type if card was digital-only
        oracle_id: card.oracle_id || null,
        cardtrader_blueprint_ids: null, // Not used anymore - linking to homepage instead
        collector_number: card.collector_number || null,
        set_code: card.set || null,
      };
    })
  );
  
  // Filter out null results (excluded alchemy cards)
  const cards: CardResult[] = cardResults.filter((card): card is CardResult => {
    return card !== null;
  });

  // Determine if there are more pages
  // Calculate how many cards we've shown so far (including this page)
  const cardsShownSoFar = (page - 1) * CARDS_PER_PAGE + cards.length;
  // We have more pages if we haven't shown all the cards yet
  const hasMore = cardsShownSoFar < scryfallResponse.total_cards;

  return {
    scryfallQuery,
    total: scryfallResponse.total_cards,
    has_more: hasMore,
    page,
    per_page: CARDS_PER_PAGE,
    cards,
  };
}

/**
 * Formats error messages for user display
 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "An unexpected error occurred";
}

/**
 * Extracts Tagger tags from a Scryfall query
 * Returns an array of { type: 'art' | 'function', tag: string, fullMatch: string }
 */
export function extractTaggerTags(query: string): Array<{ type: 'art' | 'function'; tag: string; fullMatch: string }> {
  const tags: Array<{ type: 'art' | 'function'; tag: string; fullMatch: string }> = [];
  
  // Patterns for art tags: art:, atag:, arttag:
  const artPattern = /(?:^|\s)(?:art|atag|arttag):([^\s"()]+|"[^"]+")/gi;
  // Patterns for function tags: function:, otag:, oracletag:
  const functionPattern = /(?:^|\s)(?:function|otag|oracletag):([^\s"()]+|"[^"]+")/gi;
  
  // Also handle negated tags (-art:, -function:, etc.)
  const negatedArtPattern = /(?:^|\s)-(?:art|atag|arttag):([^\s"()]+|"[^"]+")/gi;
  const negatedFunctionPattern = /(?:^|\s)-(?:function|otag|oracletag):([^\s"()]+|"[^"]+")/gi;
  
  // Extract art tags
  let match;
  while ((match = artPattern.exec(query)) !== null) {
    const tag = match[1].replace(/^"|"$/g, ''); // Remove quotes
    tags.push({ type: 'art', tag, fullMatch: match[0].trim() });
  }
  
  // Extract function tags
  while ((match = functionPattern.exec(query)) !== null) {
    const tag = match[1].replace(/^"|"$/g, ''); // Remove quotes
    tags.push({ type: 'function', tag, fullMatch: match[0].trim() });
  }
  
  // Extract negated art tags (we still want to validate them)
  while ((match = negatedArtPattern.exec(query)) !== null) {
    const tag = match[1].replace(/^"|"$/g, '');
    tags.push({ type: 'art', tag, fullMatch: match[0].trim() });
  }
  
  // Extract negated function tags
  while ((match = negatedFunctionPattern.exec(query)) !== null) {
    const tag = match[1].replace(/^"|"$/g, '');
    tags.push({ type: 'function', tag, fullMatch: match[0].trim() });
  }
  
  return tags;
}

/**
 * Validates if a Tagger tag exists by checking the cached tag list
 * Returns true if the tag exists, false if the tag doesn't exist
 */
export async function validateTaggerTag(
  type: 'art' | 'function',
  tag: string
): Promise<boolean> {
  try {
    // Ensure cache is initialized
    await ensureTaggerTagCache();

    if (taggerTagCache === null) {
      // Cache initialization failed - assume tag exists to avoid false positives
      console.warn('[Tagger Cache] Cache not available, assuming tag exists');
      return true;
    }

    const tagSet = taggerTagCache.get(type);
    if (!tagSet) {
      console.warn(`[Tagger Cache] No tags found for type: ${type}`);
      return true; // Assume exists to avoid false positives
    }

    // Check if tag exists in cache (case-insensitive comparison)
    const normalizedTag = tag.toLowerCase().trim();
    for (const cachedTag of tagSet) {
      if (cachedTag.toLowerCase() === normalizedTag) {
        return true;
      }
    }

    // Debug: log when a tag is not found (helps diagnose cache issues)
    console.log(`[Tagger Cache] Tag "${tag}" (normalized: "${normalizedTag}") not found in ${type} tags cache. Cache size: ${tagSet.size}`);
    
    return false;
  } catch (error) {
    // On cache errors, assume tag exists to avoid false positives
    // We only want to regenerate if we're confident the tag doesn't exist
    console.error(`Error validating tag ${type}:${tag}:`, error);
    return true;
  }
}

/**
 * Validates all Tagger tags in a query and returns invalid ones
 */
export async function validateTaggerTags(
  query: string
): Promise<Array<{ type: 'art' | 'function'; tag: string }>> {
  const tags = extractTaggerTags(query);
  if (tags.length === 0) {
    return [];
  }
  
  const invalidTags: Array<{ type: 'art' | 'function'; tag: string }> = [];
  
  // Validate tags using cache (no delays needed since we're not making API calls)
  for (const { type, tag } of tags) {
    const isValid = await validateTaggerTag(type, tag);
    if (!isValid) {
      invalidTags.push({ type, tag });
    }
  }
  
  return invalidTags;
}
