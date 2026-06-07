export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s{2,}/g, " ").trim();
}

/**
 * Classic DP levenshtein with O(min(m,n)) space.
 * Returns the edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const row = new Array(b.length + 1);
  for (let i = 0; i <= b.length; i += 1) row[i] = i;

  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }

  return row[b.length];
}

/**
 * Shared fuzzy-match predicate used by every Phase 1 fuzzy matcher (keywords,
 * strategies, subtypes). Accepts a candidate when:
 *   - both strings are ≥5 chars and differ in length by ≤1, AND
 *   - they are within Levenshtein distance 1, OR are an adjacent-character
 *     transposition (e.g. "aristocarts" ↔ "aristocrats").
 *
 * Centralised here so the distance policy is defined once and can be shared by
 * modules that would otherwise create an import cycle (e.g. catalog-index).
 */
export function shouldUseFuzzyMatch(token: string, candidate: string): boolean {
  if (token.length < 5 || candidate.length < 5) {
    return false;
  }
  if (Math.abs(token.length - candidate.length) > 1) {
    return false;
  }
  if (levenshteinDistance(token, candidate) <= 1) {
    return true;
  }

  if (token.length === candidate.length) {
    const mismatches: number[] = [];
    for (let i = 0; i < token.length; i += 1) {
      if (token[i] !== candidate[i]) {
        mismatches.push(i);
        if (mismatches.length > 2) {
          break;
        }
      }
    }
    if (
      mismatches.length === 2 &&
      mismatches[1] === mismatches[0] + 1 &&
      token[mismatches[0]] === candidate[mismatches[1]] &&
      token[mismatches[1]] === candidate[mismatches[0]]
    ) {
      return true;
    }
  }

  return false;
}

export interface FuzzyMatchOptions<T> {
  /** Extract the comparable lowercase string form from a candidate. */
  getForm: (candidate: T) => string;
  /** Predicate deciding whether the token fuzzily matches a candidate form. Defaults to `shouldUseFuzzyMatch`. */
  isMatch?: (token: string, form: string) => boolean;
  /** Skip any candidate whose form is shorter than this. Defaults to 0 (no floor). */
  minFormLength?: number;
  /** Tokens that must never be fuzzy-corrected; checked once before iterating. */
  blocklist?: ReadonlySet<string>;
  /** Skip individual candidates (e.g. by category or shape). */
  excludeCandidate?: (candidate: T, form: string) => boolean;
}

/**
 * Generic fuzzy-match engine shared by the Phase 1 fuzzy matchers. Centralises the
 * guard plumbing (token blocklist, minimum form length, per-candidate exclusion) and
 * the distance check so each domain only supplies its own candidate set + policy, and
 * guards added for one matcher cannot silently fail to apply to another.
 *
 * Returns the first candidate (in iteration order) that passes every guard, or null.
 */
export function findFuzzyMatch<T>(
  token: string,
  candidates: Iterable<T>,
  options: FuzzyMatchOptions<T>
): T | null {
  const lower = token.toLowerCase();
  if (options.blocklist?.has(lower)) return null;
  const isMatch = options.isMatch ?? shouldUseFuzzyMatch;
  const minFormLength = options.minFormLength ?? 0;
  for (const candidate of candidates) {
    const form = options.getForm(candidate);
    if (form.length < minFormLength) continue;
    if (options.excludeCandidate?.(candidate, form)) continue;
    if (isMatch(lower, form)) return candidate;
  }
  return null;
}
