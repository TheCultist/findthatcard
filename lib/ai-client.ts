/**
 * Unified AI client abstraction.
 * Switch providers with: AI_PROVIDER=openai (default) | AI_PROVIDER=claude
 *
 * OpenAI env vars: OPENAI_API_KEY, OPENAI_MODEL (default: gpt-4.1-mini)
 * Optional: OPENAI_REASONING_EFFORT=low|medium|high for reasoning-capable models only (Responses API).
 * Claude env vars:  ANTHROPIC_API_KEY, CLAUDE_MODEL (default: claude-haiku-4-5)
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

export type AIStructuredParams = {
  /** Optional system-level instruction. */
  system?: string;
  /** The user message content. */
  user: string;
  max_output_tokens: number;
  /** A JSON Schema (draft-07 subset) describing the required output shape. */
  schema: Record<string, unknown>;
  /** Short schema identifier (letters/digits/underscores). */
  schemaName: string;
};

export type AIStructuredResponse<T> = {
  data: T;
  usage: AIUsage;
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

async function callOpenAIStructured<T>(
  params: AIStructuredParams
): Promise<AIStructuredResponse<T>> {
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (params.system) messages.push({ role: "system", content: params.system });
  messages.push({ role: "user", content: params.user });

  // Chat Completions json_schema strict mode guarantees valid, schema-conformant
  // JSON — no markdown fences, no partial objects — so downstream never parses prose.
  const completion = await getOpenAIClient().chat.completions.create({
    model,
    messages,
    max_tokens: params.max_output_tokens,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: params.schemaName,
        schema: params.schema,
        strict: true,
      },
    },
  });

  const text = completion.choices[0]?.message?.content ?? "";
  const data = JSON.parse(text) as T;
  return {
    data,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
      total_tokens: completion.usage?.total_tokens ?? 0,
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
  const model = process.env.CLAUDE_MODEL || "claude-haiku-4-5";

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

async function callClaudeStructured<T>(
  params: AIStructuredParams
): Promise<AIStructuredResponse<T>> {
  const model = process.env.CLAUDE_MODEL || "claude-haiku-4-5";

  // Forced tool use is Claude's structured-output mechanism: the model must call
  // the single provided tool, and its `input` conforms to the JSON Schema.
  const response = await getAnthropicClient().messages.create({
    model,
    ...(params.system ? { system: params.system } : {}),
    messages: [{ role: "user", content: params.user }],
    max_tokens: params.max_output_tokens,
    tools: [
      {
        name: params.schemaName,
        description: "Return the extracted structured result.",
        input_schema: params.schema as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: params.schemaName },
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) throw new Error("Claude structured call returned no tool_use block");

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  return {
    data: toolUse.input as T,
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

/**
 * Structured-output variant: returns a parsed object conforming to `schema`.
 * OpenAI uses Chat Completions json_schema strict mode; Claude uses forced tool
 * use. Both guarantee the returned value is valid JSON matching the schema, so
 * callers only need to validate *semantics* (catalog membership), not shape.
 */
export async function callAIStructured<T>(
  params: AIStructuredParams
): Promise<AIStructuredResponse<T>> {
  const provider = getActiveProvider();
  if (provider === "claude") return callClaudeStructured<T>(params);
  return callOpenAIStructured<T>(params);
}