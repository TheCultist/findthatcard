/**
 * `npm run dev:offline` — the real app in a browser with no network.
 *
 * Starts the fake Scryfall (test/fake-scryfall) and then `next dev` pointed at it via
 * SCRYFALL_BASE_URL. Extra arguments go to `next dev` (e.g. `npm run dev:offline -- -p 3001`).
 *
 * What works: typing Scryfall syntax into the search box (`t:creature c:r`, `pyromancer`,
 * `is:dfc`, `fixture:400`…) — it passes straight through the pipeline to /api/search, which
 * fetches from the fake, runs the digital→paper substitution and renders the grid; paging; the
 * card detail panel. Natural-language queries need a real AI key and network, so without one
 * they fail with the app's normal error. A placeholder key is set if none is configured, only
 * so /api/search doesn't answer 503 before reaching Scryfall.
 */

import { spawn } from "node:child_process";
import { startFakeScryfall } from "@/test/fake-scryfall/server";

async function main() {
  const fake = await startFakeScryfall({
    port: Number(process.env.FAKE_SCRYFALL_PORT) || 4010,
    log: true,
  });
  console.log(`[dev-offline] fake Scryfall listening at ${fake.baseUrl}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SCRYFALL_BASE_URL: fake.baseUrl,
    // Background refreshes of the catalog/sets/tagger caches would fail without network.
    CACHE_REFRESH: process.env.CACHE_REFRESH ?? "off",
  };
  const keyVar = env.AI_PROVIDER?.toLowerCase().trim() === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  if (!env[keyVar]) {
    env[keyVar] = "offline-placeholder";
    console.log(`[dev-offline] ${keyVar} not set — using a placeholder; only Scryfall-syntax searches will work`);
  }

  const nextBin = process.platform === "win32" ? "next.cmd" : "next";
  const next = spawn(nextBin, ["dev", ...process.argv.slice(2)], { stdio: "inherit", env, shell: process.platform === "win32" });

  const shutdown = (signal: NodeJS.Signals) => {
    next.kill(signal);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  next.on("exit", async (code, signal) => {
    await fake.close();
    process.exit(code ?? (signal ? 1 : 0));
  });
  next.on("error", async (error) => {
    console.error("[dev-offline] could not start next dev:", error);
    await fake.close();
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
