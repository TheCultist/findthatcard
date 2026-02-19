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

export function assembleQueryFromIR(ir: SearchPipelineIR): string {
  if (ir.intent === "direct-scryfall") {
    return ir.mustClauses[0]?.value?.trim() || "";
  }

  const must = dedupeTokens(ir.mustClauses.map((clause) => clause.value));
  const should = dedupeTokens(ir.shouldClauses.map((clause) => clause.value));
  const mustNot = dedupeTokens(ir.mustNotClauses.map((clause) => `-${clause.value.replace(/^-/, "")}`));

  const phase2Tokens = dedupeTokens(
    ir.resolvedFragments.flatMap((fragment) => fragment.tags)
  );

  const parts: string[] = [];
  parts.push(...must);
  const shouldGroup = buildShouldGroup(should);
  if (shouldGroup) parts.push(shouldGroup);
  parts.push(...mustNot);
  parts.push(...phase2Tokens);

  return parts.join(" ").replace(/\s{2,}/g, " ").trim();
}

