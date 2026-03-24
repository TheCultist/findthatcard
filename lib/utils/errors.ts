/**
 * Formats error messages for user display
 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const o = error as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim()) {
      return o.message;
    }
    if (typeof o.error === "string" && o.error.trim()) {
      return o.error;
    }
  }
  return "An unexpected error occurred";
}
