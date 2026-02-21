import { ResolverCategory } from "../types";
import { getArchetypeMenu, type ArchetypeMenuEntry } from "@/lib/scryfall/query-converter";

export type BuildResolverPromptArgs = {
  category: ResolverCategory;
  fragments: string[];
  naturalQuery: string;
  availableArtTags: string[];
  availableFunctionTags: string[];
};

function categoryInstructions(category: ResolverCategory): string {
  switch (category) {
    case "art":
      return "Map each fragment to art:* tags for depicted visual subjects in the card illustration.";
    case "mechanic":
      return "Map each fragment to keyword/function/oracle tags representing game mechanics.";
    case "effect":
      return "Map each fragment to function:/oracletag:/o: tags for gameplay effects.";
    default:
      return "Map each fragment to the best Scryfall tags/operators.";
  }
}

function formatArchetypeMenu(entries: ArchetypeMenuEntry[]): string {
  return entries
    .map((e) => {
      const quals = e.qualifiers ? ` [qualifiers: ${e.qualifiers.join(", ")}]` : "";
      return `  ${e.name}: ${e.description}${quals}`;
    })
    .join("\n");
}

const FEW_SHOT_EXAMPLES = `Examples:
{"results":[{"fragment":"make opponents pay to swing at me","archetype":"pillow-fort","qualifier":null,"tags":[],"confidence":0.9}]}
{"results":[{"fragment":"etb draw effects","archetype":null,"qualifier":null,"tags":["o:enters","o:draw"],"confidence":0.85}]}
{"results":[{"fragment":"give mana when enter","archetype":null,"qualifier":null,"tags":["o:enters","o:\\"add\\""],"confidence":0.85}]}
{"results":[{"fragment":"deal damage to creatures","archetype":"damage","qualifier":"creature","tags":[],"confidence":0.9}]}
{"results":[{"fragment":"cards depicting a forest at night","archetype":null,"qualifier":null,"tags":["art:forest","art:night"],"confidence":0.8}]}
{"results":[{"fragment":"ways to get lands back from graveyard","archetype":"reanimator","qualifier":"self","tags":[],"confidence":0.7}]}`;

export function buildResolverPrompt({
  category,
  fragments,
  naturalQuery,
  availableArtTags,
  availableFunctionTags,
}: BuildResolverPromptArgs): string {
  const safeFragments = fragments.filter((f) => f.trim().length > 0).slice(0, 8);
  const compactArtTags = availableArtTags.slice(0, 40).join(", ");
  const compactFunctionTags = availableFunctionTags.slice(0, 60).join(", ");
  const archetypeMenu = formatArchetypeMenu(getArchetypeMenu());

  return [
    "You help resolve unresolved search fragments from a Magic: The Gathering card search query into Scryfall query tags.",
    "",
    `Full user query: "${naturalQuery}"`,
    `Category: ${category}`,
    categoryInstructions(category),
    "",
    "KNOWN ARCHETYPES (prefer classifying into one of these when the fragment clearly matches):",
    archetypeMenu,
    "",
    "Output JSON only (no markdown/prose). Shape:",
    '{"results":[{"fragment":"...","archetype":"name-or-null","qualifier":"qualifier-or-null","tags":["..."],"confidence":0.0}]}',
    "",
    "Rules:",
    "- If the fragment matches a known archetype above, set archetype (and qualifier if applicable). Leave tags empty -- we handle tag mapping.",
    "- If no archetype fits, set archetype to null and provide raw Scryfall tags (function:..., art:..., kw:..., o:\"...\", t:...).",
    "- use art: for depicted visual subjects (objects, creatures, scenery in card art). use artist: for illustrator names.",
    "- max 4 raw tags per fragment. Prefer function: tags from the sample list below.",
    "- confidence: 0.0-1.0. If uncertain, return empty tags with low confidence.",
    "- Do NOT return color identity, format, or type tags already handled by the rest of the query.",
    "- IMPORTANT: When the fragment describes a SPECIFIC trigger condition (enters, dies, attacks, taps, etc.), use o: oracle text tags to capture that specificity. Do NOT fall back to a broad function: archetype tag that ignores the trigger. Example: 'give mana when enters' → o:enters + o:\"add\", NOT function:ramp.",
    "- IMPORTANT: When you emit a function: tag, do NOT also add o: oracle text for the same intent. The function: tag already covers that search space and adding oracle text will over-restrict the results to zero.",
    "",
    FEW_SHOT_EXAMPLES,
    "",
    `Fragments: ${JSON.stringify(safeFragments)}`,
    `Available art tags: ${compactArtTags || "none"}`,
    `Available function tags: ${compactFunctionTags || "none"}`,
  ].join("\n");
}
