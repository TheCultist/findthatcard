/**
 * mergeKeywordMentions self-check (no network).
 *
 * Run: tsx lib/keyword-mentions.test.ts
 */

import assert from "node:assert/strict";
import { mergeKeywordMentions } from "@/lib/keyword-mentions";

let passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

const candidates = ["Flying", "Vigilance", "Double strike", "Strike", "Protection", "Hexproof", "Hexproof from", "Menace", "Heal", "Mill", "Flash"];
const definitions: Record<string, string> = Object.fromEntries(
  ["flying", "vigilance", "double-strike", "protection", "hexproof", "hexproof-from", "menace", "mill", "flash"].map((k) => [k, "def"]),
);

// Akroma's Will: no own keywords, grants several.
{
  const text =
    "Choose one. If you control a commander as you cast this spell, you may choose both.\n" +
    "• Creatures you control gain flying, vigilance, and double strike until end of turn.\n" +
    "• Creatures you control gain lifelink, indestructible, and protection from all colors until end of turn.";
  const out = mergeKeywordMentions([], text, candidates, definitions);
  check("grants detected", JSON.stringify(out) === JSON.stringify(["Double strike", "Protection", "Vigilance", "Flying"]), JSON.stringify(out));
}

// Own keywords first, no duplicates; reminder text ignored; undefined candidate (Heal) skipped.
{
  const text = "Flying (This creature can't be blocked except by creatures with flying or reach.)\nWhen this dies, heal 3 and target creature gains menace.";
  const out = mergeKeywordMentions(["Flying"], text, candidates, definitions);
  check("own first, dedup, undefined skipped", JSON.stringify(out) === JSON.stringify(["Flying", "Menace"]), JSON.stringify(out));
}

// Longest wins: "hexproof from black" → Hexproof from, not Hexproof; plural verb forms match.
{
  const out = mergeKeywordMentions([], "Target creature gains hexproof from black. Each opponent mills two cards.", candidates, definitions);
  check("longest match + plural", JSON.stringify(out) === JSON.stringify(["Hexproof from", "Mill"]), JSON.stringify(out));
}

// Not matched inside other words.
{
  const out = mergeKeywordMentions([], "Flashback {2}{R}. Overflying birds.", candidates, definitions);
  check("no substring matches", out.length === 0, JSON.stringify(out));
}

console.log(`\nAll ${passed} keyword-mention self-checks passed.`);
