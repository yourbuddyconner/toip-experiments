/**
 * Claude through the official SDK, with a manual tool-use loop (design §12.1): adaptive thinking, explicit
 * effort, strict tools, auto tool choice, non-streaming, and server-side refusal fallbacks where the model has
 * them. Credentials come from the SDK's default chain. Nothing here prints or logs a key.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Message, ModelClient, ModelRequest } from "./model";

/** The models the decisions name (2026-11-06). */
export const MODELS = { ops: "claude-opus-5-5", coder: "claude-sonnet-5-5", errands: "claude-haiku-5-5" } as const;

/** Server-side refusal fallbacks exist for these models (not for Haiku). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-5"]);

type Create = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Message>;

export class AnthropicModel implements ModelClient {
  readonly id: string;
  private readonly create: Create;
  private readonly effort: "low" | "medium" | "high";

  constructor(o: { model: string; client?: { beta: { messages: { create: Create } } }; effort?: "low" | "medium" | "high" }) {
    this.id = o.model;
    const client = o.client ?? (new Anthropic() as unknown as { beta: { messages: { create: Create } } });
    this.create = (p) => client.beta.messages.create(p);
    this.effort = o.effort ?? "medium";
  }

  /** The request the loop sends. Exposed for tests. */
  params(req: ModelRequest): Anthropic.Beta.MessageCreateParamsNonStreaming {
    const fallback = FALLBACK_MODELS.has(this.id);
    return {
      model: this.id,
      max_tokens: 16000,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools: req.tools,
      tool_choice: { type: "auto" },
      messages: req.messages,
      thinking: { type: "adaptive" },
      // Set explicitly: Opus 5.5's default is medium and other models' is high.
      output_config: { effort: this.effort },
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    } as Anthropic.Beta.MessageCreateParamsNonStreaming;
  }

  next(req: ModelRequest): Promise<Message> {
    return this.create(this.params(req));
  }
}

/**
 * Whether credentials work, by asking for the model once (design §12.1, auto mode). Never shows the key.
 * Returns a reason when they don't.
 */
export async function checkCredentials(model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await new Anthropic().models.retrieve(model);
    return { ok: true };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, reason: "the API credentials were refused" };
    if (e instanceof Anthropic.NotFoundError) return { ok: false, reason: `the model ${model} isn't available to these credentials` };
    if (e instanceof Anthropic.APIConnectionError) return { ok: false, reason: "the API couldn't be reached" };
    if (e instanceof Anthropic.APIError) return { ok: false, reason: `the API answered ${e.status}` };
    return { ok: false, reason: "no API credentials were found" };
  }
}
