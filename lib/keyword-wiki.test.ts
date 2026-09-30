/**
 * MTG Wiki reminder extraction self-check (no network).
 *
 * Run: tsx lib/keyword-wiki.test.ts
 */

import assert from "node:assert/strict";
import { cleanWikiMarkup, extractReminderFromWikitext } from "@/lib/keyword-wiki";

let passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

// Real wikitext shapes from mtg.wiki (Firebending / Landfall / Warp infoboxes).
{
  const firebending = `{{Infobox keyword
| type = Triggered
| N = N
| reminder = Whenever this creature attacks, add N {{R}}. This mana lasts until the end of combat.
| interact = firebending
}}
'''Firebending''' is a [[keyword ability]].`;
  check(
    "mana template → symbol",
    extractReminderFromWikitext(firebending) === "Whenever this creature attacks, add N {R}. This mana lasts until the end of combat.",
    extractReminderFromWikitext(firebending) ?? "null",
  );
}
{
  const landfall = `{{Infobox ability 
| icon = MTGA Landfall.png
| reminder = Whenever a land you control enters, … (nonland permanents)<br>''Landfall'' — If you had a land you control enter this turn, … (instants and sorceries)
| storm = 2
| storm_ref = <ref name= "Walk and Fall">{{EzTumblr|https://x|title=T|2025-07-03}}</ref>
}}`;
  const out = extractReminderFromWikitext(landfall);
  check("br + emphasis stripped, stops at next param", out === "Whenever a land you control enters, … (nonland permanents) Landfall — If you had a land you control enter this turn, … (instants and sorceries)", out ?? "null");
}
{
  const last = `{{Infobox keyword
| first = Edge of Eternities
| reminder = You may cast this card from your hand for its warp cost.<ref name="x">stuff</ref>
}}`;
  check("reminder as last param, ref removed", extractReminderFromWikitext(last) === "You may cast this card from your hand for its warp cost.", extractReminderFromWikitext(last) ?? "null");
}
check("no infobox → null", extractReminderFromWikitext("'''Heal''' is a [[keyword action]].") === null);
check("empty reminder → null", extractReminderFromWikitext("{{Infobox keyword\n| reminder = \n| type = x\n}}") === null);
check("links unwrapped", cleanWikiMarkup("see [[Creature|creatures]] and [[flying]]") === "see creatures and flying");

console.log(`\nAll ${passed} keyword-wiki self-checks passed.`);
