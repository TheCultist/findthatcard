/**
 * search-provenance self-check (no network): the Search-button gating, the Refined-from
 * provenance, the Restore-my-edited-query stash, and the URL query for paging.
 *
 * Run: tsx lib/search-provenance.test.ts
 */

import assert from "node:assert/strict";
import {
  canRunEdited,
  editStash,
  provenanceForEditedRun,
  provenanceForFreshRun,
  queryChanged,
  resultsUrlQuery,
  type LastRun,
  type Provenance,
} from "@/lib/search-provenance";

let passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

const ran = (query: string, failed = false): LastRun => ({ query, failed });

// Search button gating: differs-from-last-run or failed; undoing an edit disables again.
{
  check("unchanged text cannot run", !canRunEdited("t:goblin c:r", ran("t:goblin c:r")));
  check("changed text can run", canRunEdited("t:elf c:r", ran("t:goblin c:r")));
  check("undone edit disables again", !canRunEdited("t:goblin c:r", ran("t:goblin c:r")));
  check("whitespace-only difference does not count", !canRunEdited("  t:goblin c:r ", ran("t:goblin c:r")));
  check("failed run can be retried unchanged", canRunEdited("t:goblin c:r", ran("t:goblin c:r", true)));
  check("empty text never runs", !canRunEdited("   ", ran("t:goblin", true)));
  check("queryChanged matches the gate", queryChanged("a", "b") && !queryChanged(" a ", "a"));
}

// Provenance: a fresh run owns the source; an edited run records what it was refined from.
{
  const fresh = provenanceForFreshRun("cheap red goblins for modern");
  check("fresh run is not refined", fresh.refinedFrom === null && fresh.sourceQuery === "cheap red goblins for modern");

  const refined = provenanceForEditedRun(fresh, "t:goblin c:r f:modern usd<1");
  check("edited run refines from the source", refined.refinedFrom === "cheap red goblins for modern");
  check("edited run keeps the source", refined.sourceQuery === fresh.sourceQuery);

  const again = provenanceForEditedRun(refined, "t:elf c:r f:modern");
  check("second edit keeps the original origin", again.refinedFrom === "cheap red goblins for modern");

  const raw = provenanceForEditedRun(provenanceForFreshRun("t:goblin c:r"), "t:goblin c:r");
  check("raw Scryfall in the top box is not 'refined'", raw.refinedFrom === null);
  const rawEdited = provenanceForEditedRun(provenanceForFreshRun("t:goblin c:r"), "t:elf c:r");
  check("but diverging from raw Scryfall is", rawEdited.refinedFrom === "t:goblin c:r");
  check("empty source never refines", provenanceForEditedRun(provenanceForFreshRun(""), "t:elf").refinedFrom === null);
}

// The restore stash: only when the chip row holds pending or already-run edits.
{
  const source: Provenance = { sourceQuery: "red goblins", refinedFrom: null };
  check("no stash without edits", editStash("t:goblin c:r", ran("t:goblin c:r"), source) === null);
  check("no stash for an empty row", editStash("  ", ran(""), source) === null);

  const pending = editStash("t:elf c:r", ran("t:goblin c:r"), source)!;
  check("pending edits are stashed", pending !== null && pending.editableQuery === "t:elf c:r");
  check("stash carries the refined provenance", pending.provenance.refinedFrom === "red goblins");

  const refined: Provenance = { sourceQuery: "red goblins", refinedFrom: "red goblins" };
  const runEdits = editStash("t:elf c:r", ran("t:elf c:r"), refined)!;
  check("already-run edits are stashed too", runEdits !== null && runEdits.editableQuery === "t:elf c:r");
  check("their provenance survives the restore", runEdits.provenance.refinedFrom === "red goblins");
}

// The URL for paging/re-sorting reproduces what is on screen.
{
  const natural: Provenance = { sourceQuery: "red goblins", refinedFrom: null };
  check("natural run pages with the natural query", resultsUrlQuery(natural, ran("t:goblin c:r"), "x") === "red goblins");
  const refined: Provenance = { sourceQuery: "red goblins", refinedFrom: "red goblins" };
  check("refined run pages with the ran Scryfall text", resultsUrlQuery(refined, ran("t:elf c:r"), "x") === "t:elf c:r");
  check("fallback when nothing is known", resultsUrlQuery({ sourceQuery: "", refinedFrom: null }, ran(""), "x") === "x");
}

console.log(`\nsearch-provenance: ${passed} checks passed`);
