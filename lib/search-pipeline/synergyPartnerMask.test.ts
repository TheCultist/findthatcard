import assert from "node:assert/strict";
import { maskSynergyWithComplements } from "./synergyPartnerMask";

const cases: {
  name: string;
  input: string;
  mustNotInclude?: string;
  mustInclude?: string;
}[] = [
  {
    name: "hides mana dorks after combos with",
    input: "untap — stuff that combos with mana dorks for my commander deck",
    mustNotInclude: "mana dorks",
    mustInclude: "synergy-with-mask",
  },
  {
    name: "leaves green mana dorks alone (filter intent)",
    input: "green mana dorks for commander",
    mustNotInclude: "synergy-with-mask",
    mustInclude: "mana dorks",
  },
  {
    name: "keeps mana dorks as subject when phrase is 'dorks that combo with …'",
    input: "mana dorks that combo with elves",
    mustInclude: "mana dorks",
  },
];

let passed = 0;
for (const c of cases) {
  const out = maskSynergyWithComplements(c.input);
  if (c.mustNotInclude) {
    assert.ok(
      !out.toLowerCase().includes(c.mustNotInclude),
      `${c.name}: expected output not to contain "${c.mustNotInclude}", got: ${out}`
    );
  }
  if (c.mustInclude) {
    assert.ok(
      out.toLowerCase().includes(c.mustInclude.toLowerCase()),
      `${c.name}: expected output to contain "${c.mustInclude}", got: ${out}`
    );
  }
  console.log(`[PASS] synergyPartnerMask: ${c.name}`);
  passed += 1;
}
console.log(`synergyPartnerMask tests passed (${passed} total)`);
