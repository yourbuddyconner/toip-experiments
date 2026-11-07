/**
 * The model clients (design §12.1, §15): the scripted and replay models drive the loop deterministically; the
 * Anthropic client builds requests with strict tools, adaptive thinking, explicit effort and fallbacks, and the
 * loop handles refusal, pause_turn and max_tokens.
 */
import { describe, expect, it } from "vitest";
import { runSession } from "../src/loop/loop";
import { ScriptedModel } from "../src/loop/scripted";
import { RecordingModel, ReplayModel } from "../src/loop/replay";
import { AnthropicModel, MODELS } from "../src/loop/anthropic";
import { HIRER_TOOLS } from "../src/loop/tools";
import { opsScript } from "../src/roles/scripts";
import type { Message } from "../src/loop/model";
import { fixture, people, recordingGuard } from "./helpers";

const callsOf = (messages: any[]) => messages.filter((m) => m.role === "assistant").flatMap((m) => (m.content as any[]).filter((b) => b.type === "tool_use").map((b) => `${b.name}:${JSON.stringify(b.input)}`));

/** A scripted session against a fresh fixture guard (no Settle, local witness). */
async function scriptedRun(script = shortScript()) {
  const f = await fixture();
  const r = await runSession({ model: new ScriptedModel(script), guard: f.guard, role: "hirer", system: "sys", task: "task" });
  return { f, r };
}

function shortScript() {
  return {
    name: "short",
    steps: [
      { call: () => [{ name: "whoami", input: {} }] },
      { call: () => [{ name: "find_workers", input: { skill: "software" } }] },
      { call: (ctx: any) => [{ name: "offer_job", input: { worker: ctx.result("find_workers")[0].did, title: "Fix it", description: "d", category: "software.tests", maxPrice: "30", release: "ci", disputeWindowDays: 0 } }] },
      { call: () => [{ name: "payments", input: {} }] },
      { call: () => [{ name: "finish", input: { summary: "ok" } }] },
    ],
  };
}

describe("the scripted model", () => {
  it("drives the loop deterministically: the same script gives the same calls", async () => {
    const a = await scriptedRun();
    const b = await scriptedRun();
    expect(a.r.reason).toBe("finished");
    const ca = callsOf(a.r.messages).map((c) => c.replace(/did:key:\w+/g, "DID"));
    const cb = callsOf(b.r.messages).map((c) => c.replace(/did:key:\w+/g, "DID"));
    expect(ca).toEqual(cb);
    expect(ca.map((c) => c.split(":")[0])).toEqual(["whoami", "find_workers", "offer_job", "payments", "finish"]);
  });

  it("a step with `until` repeats until its condition holds, and gives up after maxRepeats", async () => {
    const f = await fixture();
    let seen = 0;
    const r = await runSession({
      model: new ScriptedModel({ name: "wait", steps: [{ call: () => (seen++, [{ name: "inbox", input: { waitSeconds: 0 } }]), until: () => false, maxRepeats: 3 }, { call: () => [{ name: "finish", input: { summary: "" } }] }] }),
      guard: f.guard,
      role: "hirer",
      system: "s",
      task: "t",
    });
    expect(r.reason).toBe("finished");
    expect(seen).toBe(3);
  });

  it("the demo's ops script starts the same way every time", async () => {
    const f = await fixture();
    const r = await runSession({ model: new ScriptedModel(opsScript()), guard: f.guard, role: "hirer", system: "s", task: "t", maxTurns: 3 });
    expect(callsOf(r.messages).map((c) => c.split(":")[0])).toEqual(["whoami", "find_workers", "offer_job", "offer_job"]);
  });
});

describe("the replay model", () => {
  it("plays a recorded session back, and fails loudly when a request differs", async () => {
    // A guard whose answers don't change, so the requests repeat exactly.
    const rec = new RecordingModel(new ScriptedModel(shortScript()));
    const a = await runSession({ model: rec, guard: recordingGuard(), role: "hirer", system: "sys", task: "task" });
    expect(rec.recording.turns.length).toBe(5);
    const b = await runSession({ model: new ReplayModel(structuredClone(rec.recording)), guard: recordingGuard(), role: "hirer", system: "sys", task: "task" });
    expect(b.reason).toBe("finished");
    expect(callsOf(b.messages)).toEqual(callsOf(a.messages));
    // A different conversation: the replay refuses to go on.
    const c = await runSession({ model: new ReplayModel(structuredClone(rec.recording)), guard: recordingGuard(), role: "hirer", system: "another system prompt", task: "task" });
    expect(c.reason).toBe("error");
    expect(c.summary).toMatch(/differs from the recording/);
    const req0 = { system: "sys", tools: HIRER_TOOLS, messages: [{ role: "user" as const, content: "task" }] };
    await expect(new ReplayModel({ model: "x", turns: [] }).next(req0)).rejects.toThrow(/only 0 turns/);
  });
});

/** A fake Messages API that returns canned responses and records requests. */
function fakeClient(responses: Partial<Message>[]) {
  const requests: any[] = [];
  let i = 0;
  return {
    requests,
    client: {
      beta: {
        messages: {
          create: async (p: any) => {
            requests.push(structuredClone(p));
            const r = responses[Math.min(i++, responses.length - 1)];
            return { id: `msg_${i}`, type: "message", role: "assistant", model: p.model, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [], stop_reason: "end_turn", ...r } as Message;
          },
        },
      },
    },
  };
}

describe("the Anthropic client", () => {
  it("builds requests with strict tools, adaptive thinking, explicit effort, auto tool choice and refusal fallbacks", () => {
    const m = new AnthropicModel({ model: MODELS.ops, client: fakeClient([]).client });
    const p = m.params({ system: "sys", tools: HIRER_TOOLS, messages: [{ role: "user", content: "hi" }] }) as any;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(p.tool_choice).toEqual({ type: "auto" });
    expect(p.max_tokens).toBe(16000);
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.fallbacks).toBe("default");
    expect(p.tools.every((t: any) => t.strict === true && t.input_schema.additionalProperties === false)).toBe(true);
    expect(p.stream).toBeUndefined();
    // Haiku has no server-side fallback.
    const h = new AnthropicModel({ model: MODELS.errands, client: fakeClient([]).client }).params({ system: "s", tools: [], messages: [] }) as any;
    expect(h.fallbacks).toBeUndefined();
    expect(h.betas).toBeUndefined();
    expect(MODELS).toEqual({ ops: "claude-opus-5-5", coder: "claude-sonnet-5-5", errands: "claude-haiku-5-5" });
  });

  it("the loop stops on a refusal, continues after pause_turn, and nudges after max_tokens", async () => {
    const f = await fixture();
    const fake = fakeClient([
      { stop_reason: "pause_turn", content: [{ type: "text", text: "thinking…" }] as any },
      { stop_reason: "max_tokens", content: [{ type: "text", text: "cut" }] as any },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_1", name: "whoami", input: {} }] as any },
      { stop_reason: "refusal", content: [] },
    ]);
    const r = await runSession({ model: new AnthropicModel({ model: MODELS.ops, client: fake.client }), guard: f.guard, role: "hirer", system: "s", task: "t" });
    expect(r.reason).toBe("refusal");
    expect(fake.requests).toHaveLength(4);
    // pause_turn: the next request continues from the appended content, with no new user turn.
    expect(fake.requests[1].messages.at(-1).role).toBe("assistant");
    // max_tokens: a short nudge.
    expect(fake.requests[2].messages.at(-1)).toEqual({ role: "user", content: "Your reply was cut off at the token limit. Carry on, more briefly." });
    // History is append-only: each request extends the previous one.
    for (let k = 1; k < fake.requests.length; k++) expect(JSON.stringify(fake.requests[k].messages).startsWith(JSON.stringify(fake.requests[k - 1].messages).slice(0, -1))).toBe(true);
  });

  it("guard notices reach the model as mid-conversation system messages", async () => {
    const f = await fixture();
    f.guard.paused = false;
    const fake = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_1", name: "whoami", input: {} }] as any },
      { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] as any },
    ]);
    (f.guard as any).noticeQueue.push("Your principal paused you.");
    const r = await runSession({ model: new AnthropicModel({ model: MODELS.ops, client: fake.client }), guard: f.guard, role: "hirer", system: "s", task: "t" });
    expect(r.reason).toBe("end_turn");
    expect(fake.requests[0].messages.at(-1)).toEqual({ role: "system", content: "Your principal paused you." });
    void people;
  });
});
