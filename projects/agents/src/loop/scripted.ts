/**
 * A deterministic model (design §12.1). A script is a list of steps. Each step returns tool calls (or text)
 * from what the conversation holds so far; a step with `until` repeats until its condition holds. It answers
 * with Message-shaped objects, so the loop can't tell it from the API.
 */
import type { Message, ModelClient, ModelRequest } from "./model";

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** What a step can see: every tool result so far, parsed. */
export class ScriptContext {
  constructor(
    readonly results: { tool: string; input: Record<string, unknown>; result: any }[],
    readonly task: string,
  ) {}

  /** Results of the last turn. */
  last: { tool: string; input: Record<string, unknown>; result: any }[] = [];

  /** Every inbox event seen so far, oldest first. */
  events(): any[] {
    return this.results.filter((r) => r.tool === "inbox" && Array.isArray(r.result)).flatMap((r) => r.result);
  }
  event(pred: (e: any) => boolean): any | undefined {
    return this.events().find(pred);
  }
  /** The latest result of a tool, optionally matching a predicate on its input. */
  result(tool: string, pred: (input: Record<string, unknown>) => boolean = () => true): any {
    return [...this.results].reverse().find((r) => r.tool === tool && pred(r.input))?.result;
  }
}

export interface Step {
  name?: string;
  /** Tool calls for this turn, or text to end with. */
  call: (ctx: ScriptContext) => ToolCall[] | string;
  /** Repeat this step until the condition holds (checked after its results). */
  until?: (ctx: ScriptContext) => boolean;
  /** At most this many repeats before moving on. Default 30. */
  maxRepeats?: number;
}

export interface Script {
  name: string;
  steps: Step[];
}

export class ScriptedModel implements ModelClient {
  readonly id: string;
  private step = 0;
  private repeats = 0;
  private turn = 0;
  private started = false;

  constructor(private readonly script: Script) {
    this.id = `scripted:${script.name}`;
  }

  async next(req: ModelRequest): Promise<Message> {
    const ctx = contextOf(req);
    // Did the step that ran last turn finish?
    if (this.started) {
      const prev = this.script.steps[this.step];
      const done = !prev?.until || prev.until(ctx) || ++this.repeats >= (prev.maxRepeats ?? 30);
      if (done) {
        this.step++;
        this.repeats = 0;
      }
    }
    this.started = true;
    const s = this.script.steps[this.step];
    this.turn++;
    if (!s) return message(this.id, this.turn, [{ type: "text", text: "Done." }], "end_turn");
    const out = s.call(ctx);
    if (typeof out === "string") return message(this.id, this.turn, [{ type: "text", text: out }], "end_turn");
    return message(
      this.id,
      this.turn,
      out.map((c, k) => ({ type: "tool_use", id: `toolu_${this.script.name.replace(/\W/g, "_")}_${this.turn}_${k}`, name: c.name, input: c.input })),
      "tool_use",
    );
  }
}

function message(model: string, n: number, content: unknown[], stop: string): Message {
  return {
    id: `msg_scripted_${n}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Message;
}

/** Rebuilds the tool calls and their results from the conversation. */
export function contextOf(req: ModelRequest): ScriptContext {
  const calls = new Map<string, { tool: string; input: Record<string, unknown> }>();
  const results: ScriptContext["results"] = [];
  let lastTurn: ScriptContext["results"] = [];
  let task = "";
  for (const m of req.messages) {
    if (m.role === "user" && typeof m.content === "string" && !task) task = m.content;
    if (!Array.isArray(m.content)) continue;
    if (m.role === "assistant") for (const b of m.content as any[]) if (b.type === "tool_use") calls.set(b.id, { tool: b.name, input: b.input });
    if (m.role === "user") {
      const turn: ScriptContext["results"] = [];
      for (const b of m.content as any[]) {
        if (b.type !== "tool_result") continue;
        const c = calls.get(b.tool_use_id);
        if (!c) continue;
        const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((x: any) => x.text ?? "").join("");
        let result: unknown = text;
        try {
          result = JSON.parse(text);
        } catch {
          // not JSON
        }
        turn.push({ ...c, result });
      }
      if (turn.length) {
        results.push(...turn);
        lastTurn = turn;
      }
    }
  }
  const ctx = new ScriptContext(results, task);
  ctx.last = lastTurn;
  return ctx;
}
