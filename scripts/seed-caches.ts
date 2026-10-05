/**
 * Refreshes the committed seed snapshots in data/seed/ (the cache fallback a fresh serverless
 * instance, clone or CI run starts from). Fetches everything fresh into a temp dir — seed
 * fallback disabled — then copies the files over. Run: npm run seed
 */
import { copyFileSync, mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const FILES = ["scryfall-catalogs.json", "scryfall-sets.json", "mtg-keywords.json", "tagger-tags.json"];

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "ftc-seed-"));
  // Must be set before the cache modules load: they resolve their paths at import time.
  process.env.CACHE_DIR = dir;
  process.env.CACHE_SEED = "off";

  const [{ ensureScryfallCatalogCache }, { ensureScryfallSetCache }, { ensureMtgKeywordCache }, { ensureTaggerTagCache }] =
    await Promise.all([
      import("@/lib/scryfall/catalogs"),
      import("@/lib/scryfall/sets"),
      import("@/lib/mtg-keywords"),
      import("@/lib/tagger/cache"),
    ]);
  await Promise.all([ensureScryfallCatalogCache(), ensureScryfallSetCache(), ensureMtgKeywordCache(), ensureTaggerTagCache()]);

  mkdirSync(join("data", "seed"), { recursive: true });
  for (const file of FILES) {
    copyFileSync(join(dir, file), join("data", "seed", file)); // throws if a fetch failed — no partial seed
    console.log(`[Seed] data/seed/${file}`);
  }
  process.exit(0); // background keyword-reminder learning would otherwise keep the process alive
}

main().catch((error) => {
  console.error("[Seed] Failed:", error);
  process.exit(1);
});
