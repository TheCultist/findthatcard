/** Returns today's date as an ISO date string (YYYY-MM-DD). */
export function formatTodayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns true when the cached file stamp is already up-to-date (same day or newer). */
export function shouldSkipUpdate(fileStamp: string | null, todayStamp: string): boolean {
  if (!fileStamp) return false;
  return fileStamp >= todayStamp;
}
