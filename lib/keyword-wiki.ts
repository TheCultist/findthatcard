import { scryfallFetch } from "@/lib/scryfall/http";
/**
 * Reminder text for keywords from the MTG Wiki (mtg.wiki). Every keyword and
 * ability word page carries an infobox with a `| reminder = …` field; we read the
 * page wikitext via the MediaWiki API and clean the markup. Used to auto-fill
 * definitions for keywords that appear in Scryfall's catalogs after the static
 * data/mtg-keyword-reminders.json was written.
 */

const WIKI_API = "https://mtg.wiki/api.php";

/** Pulls the infobox `reminder` parameter (may span lines) out of page wikitext. */
export function extractReminderFromWikitext(wikitext: string): string | null {
  const m = wikitext.match(/^\s*\|\s*reminder\s*=[ \t]*([\s\S]*?)(?=\n\s*\|\s*[\w ]+\s*=|\n\}\})/m);
  const cleaned = m ? cleanWikiMarkup(m[1]) : "";
  return cleaned || null;
}

/** Strips refs, links, emphasis and templates; mana templates become {R}-style symbols. */
export function cleanWikiMarkup(raw: string): string {
  return raw
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\{\{([A-Za-z0-9/]{1,4})\}\}/g, "{$1}")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWikitext(title: string): Promise<string | null> {
  const url = `${WIKI_API}?action=parse&prop=wikitext&format=json&redirects=1&page=${encodeURIComponent(title)}`;
  const res = await scryfallFetch(url);
  if (!res.ok) return null;
  const json = (await res.json()) as { parse?: { wikitext?: { "*"?: string } } };
  return json.parse?.wikitext?.["*"] ?? null;
}

/**
 * Reminder text for a keyword by its Scryfall catalog name, or null if the wiki
 * has no page / no reminder. Tries the catalog casing, then sentence case
 * ("Level Up" → "Level up") since MediaWiki titles are case-sensitive past the first letter.
 */
export async function fetchWikiReminder(name: string): Promise<string | null> {
  const sentence = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  for (const title of new Set([name, sentence])) {
    try {
      const wikitext = await fetchWikitext(title);
      const reminder = wikitext && extractReminderFromWikitext(wikitext);
      if (reminder) return reminder;
    } catch (error) {
      console.warn(`[Keyword Wiki] Failed to fetch "${title}":`, error);
    }
  }
  return null;
}
