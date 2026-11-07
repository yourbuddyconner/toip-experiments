/** The model client interface (design §12.1). Three implementations: Anthropic, scripted, replay. */
import type Anthropic from "@anthropic-ai/sdk";

export type Message = Anthropic.Beta.BetaMessage;
export type MessageParam = Anthropic.Beta.BetaMessageParam;

export interface ModelRequest {
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  messages: MessageParam[];
}

export interface ModelClient {
  /** "claude-opus-5-5", or "scripted:<script name>". */
  readonly id: string;
  next(req: ModelRequest): Promise<Message>;
}
