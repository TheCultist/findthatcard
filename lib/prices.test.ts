/**
 * formatPrice self-check (no network).
 *
 * Run: tsx lib/prices.test.ts
 */

import assert from "node:assert/strict";
import { formatPrice } from "@/lib/prices";

assert.equal(formatPrice({ usd: "0.55", eur: "0.42" }, "usd"), "$0.55");
assert.equal(formatPrice({ usd: "0.55", eur: "0.42" }, "eur"), "€0.42");
assert.equal(formatPrice({ usd: "1234.5", eur: null }, "usd"), "$1,234.50");
assert.equal(formatPrice({ usd: null, eur: null }, "usd"), null, "null listing → null");
assert.equal(formatPrice({ usd: "n/a", eur: null }, "usd"), null, "garbage string → null");
console.log("[PASS] formatPrice");
