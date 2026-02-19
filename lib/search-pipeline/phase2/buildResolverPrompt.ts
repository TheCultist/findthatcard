import { ResolverCategory } from "../types";

type BuildResolverPromptArgs = {
  category: ResolverCategory;
  fragments: string[];
  availableArtTags: string[];
  availableFunctionTags: string[];
};

function categoryInstructions(category: ResolverCategory): string {
  switch (category) {
    case "art":
      return "Map each fragment to art:* tags only when appropriate.";
    case "mechanic":
      return "Map each fragment to direct keyword/function/oracle tags that represent mechanics.";
    case "effect":
      return "Map each fragment to concise function:/oracletag:/o: tags for gameplay effects.";
    default:
      return "Map each fragment to the smallest valid Scryfall tags/operators with no prose.";
  }
}

export function buildResolverPrompt({
  category,
  fragments,
  availableArtTags,
  availableFunctionTags,
}: BuildResolverPromptArgs): string {
  const safeFragments = fragments.filter((fragment) => fragment.trim().length > 0).slice(0, 8);
  const compactArtTags = availableArtTags.slice(0, 30).join(", ");
  const compactFunctionTags = availableFunctionTags.slice(0, 40).join(", ");

  return [
    "You convert unresolved search fragments into Scryfall query tags.",
    categoryInstructions(category),
    "Output JSON only (no markdown/prose) with shape:",
    '{"results":[{"fragment":"...","tags":["..."],"confidence":0.0}]}',
    "Rules:",
    "- tags must be valid Scryfall tokens (e.g. function:..., art:..., kw:..., o:\"...\", t:..., id:..., set:...).",
    "- use art: for depicted visual subjects (objects, creatures, scenery, motifs in the card art).",
    "- use artist: for illustrator names (people), never art: for artist names.",
    "- max 4 tags per fragment.",
    "- if uncertain, return empty tags with low confidence.",
    "",
    `Category: ${category}`,
    `Fragments: ${JSON.stringify(safeFragments)}`,
    `Available art tags sample: ${compactArtTags || "none"}`,
    `Available function tags sample: ${compactFunctionTags || "none"}`,
  ].join("\n");
}

