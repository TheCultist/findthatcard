/**
 * Shared debug/logging helpers for the search pipeline.
 *
 * Env vars:
 *   LOG_SEARCH_PIPELINE_DEBUG — set to "true" / "1" / "yes" to enable pipeline stage logging.
 *   LOG_AI_AGENT_PROMPT       — set to "true" / "1" to force AI prompt logging on;
 *                               "false" / "0" to force off; defaults to non-production.
 */

export function isPipelineDebugEnabled(): boolean {
  const v = process.env.LOG_SEARCH_PIPELINE_DEBUG?.toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export function isAiPromptLoggingEnabled(): boolean {
  const configured = process.env.LOG_AI_AGENT_PROMPT?.toLowerCase();
  if (configured === "true" || configured === "1") return true;
  if (configured === "false" || configured === "0") return false;
  return process.env.NODE_ENV !== "production";
}
