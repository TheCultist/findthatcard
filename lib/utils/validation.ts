const MAX_QUERY_LENGTH = 400;

/**
 * Validates natural language query input
 */
export function validateNaturalQuery(
  query: string
): { valid: boolean; error?: string } {
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
