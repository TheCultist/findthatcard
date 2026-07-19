/**
 * Tiny in-memory LRU for V2 extraction results, keyed by normalized query.
 * Repeat searches (very common from pagination and shared links) skip the AI
 * call entirely. Process-local and best-effort — not a correctness dependency.
 *
 * ponytail: fixed-capacity Map-as-LRU (O(1) via delete+set reinsertion). If this
 * ever needs cross-process sharing, swap for Redis behind the same interface.
 */

const MAX_ENTRIES = 500;

export function normalizeCacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export class LruCache<V> {
  private store = new Map<string, V>();
  constructor(private readonly capacity: number = MAX_ENTRIES) {}

  get(key: string): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    // Reinsert to mark as most-recently-used.
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, value);
    if (this.store.size > this.capacity) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }
}
