/**
 * Pure decisions behind the results-page query bar: when the Search button next to the chip row is
 * enabled, which natural-language query an edited Scryfall query descends from ("Refined from"),
 * what to stash when a new top-box search would overwrite chip edits ("Restore my edited query"),
 * and which query the URL should carry when paging or re-sorting. Kept out of the component so the
 * rules are testable without React.
 */

/** The last search that actually ran: its Scryfall text and whether it failed. */
export type LastRun = { query: string; failed: boolean };

/**
 * Where the current results came from. `sourceQuery` is what the user typed in the top box (or an
 * example/recent chip); `refinedFrom` is set once the chip row was edited and run, and holds the
 * natural-language query those edits descend from.
 */
export type Provenance = { sourceQuery: string; refinedFrom: string | null };

/** What "Restore my edited query" brings back after a top-box search replaced chip edits. */
export type EditStash = { editableQuery: string; provenance: Provenance };

/** True while the edited text differs from the query whose results are on screen. */
export function queryChanged(editableQuery: string, lastRunQuery: string): boolean {
  return editableQuery.trim() !== lastRunQuery.trim();
}

/** The Search button / Enter run only something new, or a retry after a failure. */
export function canRunEdited(editableQuery: string, lastRun: LastRun): boolean {
  return Boolean(editableQuery.trim()) && (queryChanged(editableQuery, lastRun.query) || lastRun.failed);
}

/** A top-box (or example/recent chip) search: it owns the provenance from scratch. */
export function provenanceForFreshRun(searchQuery: string): Provenance {
  return { sourceQuery: searchQuery, refinedFrom: null };
}

/**
 * Running the edited chip row keeps the natural-language source and marks the run as refined from
 * it — unless the source is empty or is the very text being run (the user typed raw Scryfall in the
 * top box and never diverged), in which case there is nothing to refine from.
 */
export function provenanceForEditedRun(current: Provenance, editedQuery: string): Provenance {
  const source = current.sourceQuery.trim();
  const refinedFrom =
    current.refinedFrom ?? (source && source !== editedQuery.trim() ? current.sourceQuery : null);
  return { sourceQuery: current.sourceQuery, refinedFrom };
}

/**
 * What to protect before a new top-box search runs: the edited chip row, when it holds pending
 * edits (text differs from the last run) or already-run edits (the last run was refined). null when
 * there is nothing a restore could bring back.
 */
export function editStash(editableQuery: string, lastRun: LastRun, provenance: Provenance): EditStash | null {
  if (!editableQuery.trim()) return null;
  const hasEdits = queryChanged(editableQuery, lastRun.query) || provenance.refinedFrom !== null;
  if (!hasEdits) return null;
  return { editableQuery, provenance: provenanceForEditedRun(provenance, editableQuery) };
}

/**
 * The query the URL carries when paging or re-sorting, so reload and share reproduce the results on
 * screen: the ran Scryfall text for a refined run, the natural-language source otherwise.
 */
export function resultsUrlQuery(provenance: Provenance, lastRun: LastRun, fallback: string): string {
  if (provenance.refinedFrom !== null) return lastRun.query || fallback;
  return provenance.sourceQuery || fallback;
}
