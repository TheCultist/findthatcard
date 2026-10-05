import assert from "node:assert/strict";
import { createCacheLoader } from "@/lib/utils/cache";
import { createRateLimiter } from "@/lib/utils/rate-limit";

async function run() {
  // Cache loader: a failed load (cache left empty) is retried, but not inside the retry window.
  let cache: string[] | null = null;
  let loads = 0;
  let upstreamUp = false;
  const ensure = createCacheLoader(
    () => cache !== null,
    async () => {
      loads++;
      if (upstreamUp) cache = ["ok"];
    },
    { retryMs: 50 }
  );
  await Promise.all([ensure(), ensure()]);
  assert.equal(loads, 1, "concurrent callers share one load");
  await ensure();
  assert.equal(loads, 1, "no retry inside the window");
  upstreamUp = true;
  await new Promise((r) => setTimeout(r, 60));
  await ensure();
  assert.deepEqual([loads, cache], [2, ["ok"]], "retried after the window and populated");
  await ensure();
  assert.equal(loads, 2, "no reload once populated");
  console.log("[PASS] cache loader: single-flight, throttled retry until populated");

  // Stale-while-revalidate: a loaded-but-stale cache resolves at once and refreshes in the background.
  delete process.env.CACHE_REFRESH; // CI sets it to off; this check is about the refresh itself
  let stamp = "yesterday";
  let refreshes = 0;
  let release!: () => void;
  const swr = createCacheLoader(
    () => true,
    () => {
      refreshes++;
      return new Promise<void>((r) => (release = r)).then(() => void (stamp = "today"));
    },
    { retryMs: 0, isFresh: () => stamp === "today" }
  );
  await swr(); // resolves while the refresh is still pending
  await swr(); // shares the in-flight refresh, no second load
  assert.deepEqual([refreshes, stamp], [1, "yesterday"], "served stale, one background refresh");
  release();
  await new Promise((r) => setTimeout(r, 0));
  await swr();
  assert.deepEqual([refreshes, stamp], [1, "today"], "fresh after refresh, no further loads");
  console.log("[PASS] cache loader: stale-while-revalidate");

  // Rate limiter: N per window per key, then a Retry-After in seconds; keys are independent.
  const limit = createRateLimiter(2, 10_000);
  assert.deepEqual([limit("a", 0), limit("a", 1), limit("a", 2)], [0, 0, 10]);
  assert.equal(limit("b", 2), 0, "other clients unaffected");
  assert.equal(limit("a", 10_000), 0, "window resets");
  console.log("[PASS] rate limiter: per-key fixed window");

  console.log("\nAll 3 utils self-checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
