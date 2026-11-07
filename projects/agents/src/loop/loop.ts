/**
 * The loop (design §12.2): the model plus a dispatcher. Untrusted. It sees tool names, JSON inputs and JSON
 * results, and reaches everything else through the GuardApi. It never edits earlier turns: each response is
 * appended unchanged.
 */
import type { GuardApi } from "../guard/api";
import { hashOf } from "./hash";
import type { MessageParam, ModelClient } from "./model";
import { requestHash } from "./replay";
import { dispatch, toolsFor, toolsHash, validate } from "./tools";

export interface SessionOptions {
  model: ModelClient;
  guard: GuardApi;
  role: "hirer" | "worker";
  system: string;
  task: string;
  maxTurns?: number;
  /** Called after each turn, for narration. */
  onTurn?: (t: { n: number; tools: { name: string; input: unknown; result: unknown }[]; text: string }) => void;
  /** How long to sleep between checks while paused. */
  pausePollMs?: number;
}

export interface SessionResult {
  reason: "finished" | "end_turn" | "refusal" | "max_turns" | "stopped" | "error";
  summary?: string;
  turns: number;
  messages: MessageParam[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSession(o: SessionOptions): Promise<SessionResult> {
  const tools = toolsFor(o.role);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const messages: MessageParam[] = [{ role: "user", content: o.task }];
  await o.guard.sessionStart({ model: o.model.id, systemHash: hashOf(o.system), toolsHash: toolsHash(tools), task: o.task });
  const maxTurns = o.maxTurns ?? 60;
  let reason: SessionResult["reason"] = "max_turns";
  let summary: string | undefined;
  let n = 0;
  try {
    for (; n < maxTurns; ) {
      while (o.guard.control() === "paused") await sleep(o.pausePollMs ?? 500);
      if (o.guard.control() === "stopped") {
        reason = "stopped";
        break;
      }
      // Notices from the guard reach the model as mid-conversation system messages: the operator's channel.
      const notices = o.guard.notices();
      if (notices.length && messages[messages.length - 1]?.role === "user") messages.push({ role: "system", content: notices.join("\n") } as MessageParam);
      const req = { system: o.system, tools, messages };
      const res = await o.model.next(req);
      n++;
      await o.guard.modelTurn({ model: res.model, requestHash: requestHash(req), stopReason: res.stop_reason, usage: res.usage, content: res.content });
      messages.push({ role: "assistant", content: res.content } as MessageParam);
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      if (res.stop_reason === "refusal") {
        reason = "refusal";
        break;
      }
      if (res.stop_reason === "pause_turn") continue;
      const uses = res.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
      if (res.stop_reason === "max_tokens" && !uses.length) {
        messages.push({ role: "user", content: "Your reply was cut off at the token limit. Carry on, more briefly." });
        continue;
      }
      if (!uses.length) {
        reason = "end_turn";
        summary = text || undefined;
        break;
      }
      const results: { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }[] = [];
      const narrated: { name: string; input: unknown; result: unknown }[] = [];
      let finished = false;
      for (const u of uses) {
        const t = byName.get(u.name);
        await o.guard.toolCall({ tool: u.name, input: u.input, id: u.id });
        let result: unknown;
        let error = false;
        if (!t) {
          result = { ok: false, error: `unknown tool ${u.name}` };
          error = true;
        } else {
          const problems = validate(t, u.input);
          if (problems.length) {
            // Refused before it reaches the guard's tools.
            result = { ok: false, error: `the input doesn't fit the tool: ${problems.join("; ")}` };
            error = true;
          } else {
            try {
              result = await dispatch(o.guard, u.name, u.input as Record<string, unknown>);
            } catch (e) {
              result = { ok: false, error: String((e as Error)?.message ?? e) };
              error = true;
            }
            if (u.name === "finish") {
              finished = true;
              summary = String((u.input as { summary?: string }).summary ?? "");
            }
          }
        }
        await o.guard.toolResult({ tool: u.name, id: u.id, result, error });
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(result), ...(error ? { is_error: true } : {}) });
        narrated.push({ name: u.name, input: u.input, result });
      }
      // All results in one user message (parallel tool use).
      messages.push({ role: "user", content: results });
      o.onTurn?.({ n, tools: narrated, text });
      if (finished) {
        reason = "finished";
        break;
      }
    }
  } catch (e) {
    reason = "error";
    summary = String((e as Error)?.message ?? e);
  }
  await o.guard.sessionEnd({ reason, ...(summary ? { summary } : {}) });
  return { reason, ...(summary ? { summary } : {}), turns: n, messages };
}
