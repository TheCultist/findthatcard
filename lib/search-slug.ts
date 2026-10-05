/** Queries of plain words get a readable /search/<slug> URL; anything else uses ?q=. */
export const isSimpleQuery = (value: string) => /^[a-zA-Z0-9 ]+$/.test(value);

export const slugifyQuery = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The query a /search/<slug> page searches for (lowercase words — what the client sends). */
export const getQueryFromSlug = (slug: string | string[]) => {
  const slugValue = Array.isArray(slug) ? slug.join(" ") : slug;
  return slugValue.replace(/-/g, " ");
};
