import { buildSystemPrompt } from "@/lib/prompts/promptModules";

/**
 * System prompt for OpenAI to convert natural language queries to Scryfall query syntax
 * Sourced from prompt modules to keep rules in one place.
 */
export const SCRYFALL_QUERY_CONVERTER_SYSTEM_PROMPT = buildSystemPrompt("");
