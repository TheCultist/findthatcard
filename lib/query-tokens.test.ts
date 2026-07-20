/**
 * getColorSemanticSelectors self-check (no network).
 *
 * Run: tsx lib/query-tokens.test.ts
 */

import assert from "node:assert/strict";
import { getColorSemanticSelectors } from "@/lib/query-tokens";

let passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

// Multi-color c: token → three options, "all" current, OR-group offered.
{
  const [sel] = getColorSemanticSelectors("c:rg function:sacrifice-outlet game:paper");
  check("c: detected", sel?.field === "c" && sel.letters === "rg");
  check("c: three options", sel.options.length === 3);
  const current = sel.options.find((o) => o.current);
  check("c:rg current is 'all'", current?.clause === "c:rg", current?.clause);
  const any = sel.options.find((o) => o.clause === "(c:r or c:g)");
  check(
    "c OR rewrite",
    any?.query === "(c:r or c:g) function:sacrifice-outlet game:paper",
    any?.query
  );
}

// Existing OR-group is recognized as current "any" and can switch back to c:rg.
{
  const [sel] = getColorSemanticSelectors("(c:r or c:g) t:creature");
  check("group letters normalized", sel?.letters === "rg", sel?.letters);
  check("group current is 'any'", sel.options.find((o) => o.current)?.clause === "(c:r or c:g)");
  const all = sel.options.find((o) => o.clause === "c:rg");
  check("group → all rewrite", all?.query === "c:rg t:creature", all?.query);
}

// id token keeps the legacy toggle semantics plus id>= for multicolor.
{
  const [sel] = getColorSemanticSelectors("id=wu t:instant");
  check("id detected", sel?.field === "id" && sel.letters === "wu");
  check("id= current is exact", sel.options.find((o) => o.current)?.clause === "id=wu");
  const within = sel.options.find((o) => o.clause === "id:wu");
  check("id within rewrite", within?.query === "id:wu t:instant", within?.query);
  check("id>= offered for multicolor", sel.options.some((o) => o.clause === "id>=wu"));
}

// Mono id has no id>= option; letters are WUBRG-sorted for display lookup.
{
  const [sel] = getColorSemanticSelectors("id:gr");
  check("letters wubrg-sorted", sel?.letters === "rg", sel?.letters);
  const [mono] = getColorSemanticSelectors("id:r");
  check("mono id has two options", mono.options.length === 2);
}

// Both c and id present → two selectors; negated clauses ignored.
{
  const both = getColorSemanticSelectors("c:r id:wub");
  check("both fields detected", both.length === 2);
  check("negated ignored", getColorSemanticSelectors("-c:r t:creature").length === 0);
  check("no color → no selector", getColorSemanticSelectors("t:creature o:draw").length === 0);
}

console.log(`\nAll ${passed} query-token self-checks passed.`);
