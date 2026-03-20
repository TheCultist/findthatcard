import { SearchPipelineIR } from "@/lib/search-pipeline/types";

function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const token of tokens) {
    const normalized = token.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
}

function buildShouldGroup(tokens: string[]): string {
  if (tokens.length === 0) return "";
  if (tokens.length === 1) return tokens[0];
  return `(${tokens.join(" OR ")})`;
}

const ART_TAG_PREFIX = /^(art|atag|arttag):/i;
function isArtTag(token: string): boolean {
  return ART_TAG_PREFIX.test(token.trim());
}

/** Prefixes whose multiple values within one fragment should be OR-chained. */
const OR_CHAIN_PREFIXES = [
  /^function:/i,
  /^oracletag:/i,
  /^(art|atag|arttag):/i,
];

function getOrChainPrefix(token: string): string | null {
  for (const re of OR_CHAIN_PREFIXES) {
    const m = re.exec(token.trim());
    if (m) return m[0].toLowerCase();
  }
  return null;
}

/** Build one (art:a or art:b) group; keeps slugs deduped. */
function buildArtOrChain(artTags: string[]): string {
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const t of artTags) {
    const normalized = t.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    slugs.push(normalized.startsWith("art:") ? normalized : `art:${normalized.replace(/^(atag|arttag):/i, "")}`);
  }
  if (slugs.length === 0) return "";
  if (slugs.length === 1) return `(${slugs[0]})`;
  return `(${slugs.join(" or ")})`;
}

/** Emit fragment tags, grouping same-prefix OR-chain tags into (a or b) clauses. */
function emitFragmentTags(tags: string[]): string[] {
  // Separate art tags (already have their own logic)
  const artTags = tags.filter(isArtTag);
  const rest = tags.filter((t) => !isArtTag(t));

  // Group rest by OR-chain prefix; non-OR-chain tags stay individual
  const groups = new Map<string, string[]>();
  const singles: string[] = [];

  for (const tag of rest) {
    const prefix = getOrChainPrefix(tag);
    if (prefix) {
      if (!groups.has(prefix)) groups.set(prefix, []);
      groups.get(prefix)!.push(tag);
    } else {
      singles.push(tag);
    }
  }

  const result: string[] = [];

  // Art OR chain
  if (artTags.length > 0) {
    const group = buildArtOrChain(artTags);
    if (group) result.push(group);
  }

  // Grouped OR chains (function:, oracletag:, etc.)
  for (const members of groups.values()) {
    if (members.length === 1) {
      result.push(members[0]);
    } else {
      const deduped = [...new Set(members.map((t) => t.trim().toLowerCase()))];
      result.push(`(${deduped.join(" or ")})`);
    }
  }

  result.push(...singles);
  return result;
}

export function assembleQueryFromIR(ir: SearchPipelineIR): string {
  if (ir.intent === "direct-scryfall") {
    return ir.mustClauses[0]?.value?.trim() || "";
  }

  const must = dedupeTokens(ir.mustClauses.map((clause) => clause.value));
  const should = dedupeTokens(ir.shouldClauses.map((clause) => clause.value));
  const mustNot = dedupeTokens(ir.mustNotClauses.map((clause) => `-${clause.value.replace(/^-/, "")}`));

  // Iterate in original query order (unresolvedFragments preserves it) so we can
  // correctly OR-group consecutive fragments that were joined by "or" in the query.
  const phase2Parts: string[] = [];
  let orGroupTags: string[] = [];

  const flushOrGroup = () => {
    const filtered = orGroupTags.map((t) => t.trim()).filter((t) => t.length > 0);
    orGroupTags = [];
    if (filtered.length === 0) return;
    if (filtered.length === 1) {
      phase2Parts.push(filtered[0]);
    } else {
      // Flatten into one big OR chain: ((A or B) or (C or D)) → (A or B or C or D)
      const inner = filtered
        .map((t) => t.replace(/^\((.+)\)$/, "$1"))
        .join(" or ");
      phase2Parts.push(`(${inner})`);
    }
  };

  for (const unresolved of ir.unresolvedFragments) {
    const resolved = ir.resolvedFragments.find(
      (f) => !f.archetype && f.fragment.toLowerCase() === unresolved.text.toLowerCase()
    );
    if (!resolved) {
      if (!unresolved.orConnected) flushOrGroup();
      continue;
    }
    const emitted = emitFragmentTags(resolved.tags);
    if (emitted.length === 0) {
      if (!unresolved.orConnected) flushOrGroup();
      continue;
    }
    const joinedEmitted = emitted.join(" ").trim();
    if (!joinedEmitted) {
      if (!unresolved.orConnected) flushOrGroup();
      continue;
    }
    if (unresolved.orConnected && orGroupTags.length > 0) {
      orGroupTags.push(joinedEmitted);
    } else {
      flushOrGroup();
      orGroupTags.push(joinedEmitted);
    }
  }
  flushOrGroup();

  const phase2Tokens = dedupeTokens(phase2Parts);

  const parts: string[] = [];
  parts.push(...must);
  const shouldGroup = buildShouldGroup(should);
  if (shouldGroup) parts.push(shouldGroup);
  parts.push(...mustNot);
  parts.push(...phase2Tokens);

  return parts.join(" ").replace(/\s{2,}/g, " ").trim();
}

