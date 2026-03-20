/**
 * Unified AI client abstraction.
 * Switch providers with: AI_PROVIDER=openai (default) | AI_PROVIDER=claude
 *
 * OpenAI env vars: OPENAI_API_KEY, OPENAI_MODEL (default: gpt-4.1-mini)
 * Optional: OPENAI_REASONING_EFFORT=low|medium|high for reasoning-capable models only (Responses API).
 * Claude env vars:  ANTHROPIC_API_KEY, CLAUDE_MODEL (default: claude-3-5-haiku-20241022)
 */
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

export type AIProvider = "openai" | "claude";

export type AIUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type AIResponse = {
  text: string;
  usage: AIUsage;
};

export type AIRequestParams = {
  /** Optional system-level instruction. */
  system?: string;
  /** The user message content. */
  user: string;
  max_output_tokens: number;
};

export function getActiveProvider(): AIProvider {
  const raw = process.env.AI_PROVIDER?.toLowerCase().trim();
  if (raw === "claude") return "claude";
  return "openai";
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

function parseReasoningEffort():
  | { effort: "low" | "medium" | "high" }
  | undefined {
  const raw = process.env.OPENAI_REASONING_EFFORT?.trim().toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high") {
    return { effort: raw };
  }
  return undefined;
}

async function callOpenAI(params: AIRequestParams): Promise<AIResponse> {
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const input: Array<{ role: "system" | "user"; content: string }> = [];
  if (params.system) input.push({ role: "system", content: params.system });
  input.push({ role: "user", content: params.user });

  const reasoning = parseReasoningEffort();

  const response = await getOpenAIClient().responses.create({
    model,
    ...(reasoning ? { reasoning } : {}),
    input,
    max_output_tokens: params.max_output_tokens,
  });

  return {
    text: response.output_text?.trim() ?? "",
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
    },
  };
}

// ── Anthropic Claude ──────────────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (anthropicClient) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is missing");
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

async function callClaude(params: AIRequestParams): Promise<AIResponse> {
  const model = process.env.CLAUDE_MODEL || "claude-3-5-haiku-20241022";

  const response = await getAnthropicClient().messages.create({
    model,
    ...(params.system ? { system: params.system } : {}),
    messages: [{ role: "user", content: params.user }],
    max_tokens: params.max_output_tokens,
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  return {
    text: text.trim(),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function callAI(params: AIRequestParams): Promise<AIResponse> {
  const provider = getActiveProvider();
  if (provider === "claude") return callClaude(params);
  return callOpenAI(params);
}