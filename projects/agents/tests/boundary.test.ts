/**
 * The loop/guard boundary (design §5, §15): the loop's import graph doesn't reach an identity, the Settle
 * party or the event log; tool inputs that fail their schema never reach the guard; unknown tools are errors.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runSession } from "../src/loop/loop";
import { ScriptedModel } from "../src/loop/scripted";
import { HIRER_TOOLS, WORKER_TOOLS, validate } from "../src/loop/tools";
import { recordingGuard } from "./helpers";

const SRC = resolve(import.meta.dirname, "..", "src");

/** Every module the loop can load, following relative imports (type-only imports included, to be strict). */
function closure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith(".")) {
        const base = resolve(dirname(file), spec);
        const f = [`${base}.ts`, join(base, "index.ts"), base].find((x) => existsSync(x) && x.endsWith(".ts"));
        if (!f) throw new Error(`can't resolve ${spec} from ${file}`);
        visit(f);
      } else packages.add(spec);
    }
  };
  visit(entry);
  return { files, packages };
}

describe("the loop can't reach keys, the party or the log", () => {
  it("imports nothing but the SDK, node built-ins, its own modules and the guard's types", () => {
    const { files, packages } = closure(join(SRC, "loop", "loop.ts"));
    for (const f of ["scripted.ts", "replay.ts", "anthropic.ts"]) for (const x of closure(join(SRC, "loop", f)).files) files.add(x);
    const rel = [...files].map((f) => f.slice(SRC.length + 1)).sort();
    expect(rel.every((f) => f.startsWith("loop/") || f === "guard/api.ts")).toBe(true);
    for (const p of packages) expect(p === "@anthropic-ai/sdk" || p.startsWith("node:")).toBe(true);
    // In particular:
    expect(rel).not.toContain("guard/guard.ts");
    expect(rel).not.toContain("audit/sink.ts");
    expect([...packages].some((p) => p.includes("trust-core") || p.includes("settle") || p.includes("eventlog") || p.includes("mandates"))).toBe(false);
  });

  it("guard/api.ts is types only", () => {
    const text = readFileSync(join(SRC, "guard", "api.ts"), "utf8");
    expect(text).not.toMatch(/^import /m);
    expect(text).not.toMatch(/\b(class|function|const|let)\b/);
  });
});

describe("tool inputs are checked before they reach the guard", () => {
  it("every tool is strict, closed and fully required", () => {
    for (const t of [...HIRER_TOOLS, ...WORKER_TOOLS]) {
      const s = t.input_schema as unknown as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
      expect(t.strict).toBe(true);
      expect(s.additionalProperties).toBe(false);
      expect(new Set(s.required)).toEqual(new Set(Object.keys(s.properties)));
      // Strict schemas carry no numeric or length limits; those are checked locally.
      expect(JSON.stringify(s)).not.toMatch(/maxLength|minimum|maximum|maxItems/);
    }
  });

  it("refuses inputs that don't fit: extra fields, wrong types, out of range, missing", () => {
    const hire = HIRER_TOOLS.find((t) => t.name === "hire")!;
    const offer = HIRER_TOOLS.find((t) => t.name === "offer_job")!;
    expect(validate(hire, { quote: "q-1", justification: "x" })).toEqual([]);
    expect(validate(hire, { quote: "q-1" })).toContain("missing property justification");
    expect(validate(hire, { quote: "q-1", justification: "x", attester: "me" })).toContain("unexpected property attester");
    expect(validate(hire, { quote: 7, justification: "x" })).toContain("quote must be a string");
    expect(validate(offer, { worker: "w", title: "t", description: "d", category: "c", maxPrice: "1", release: "anyone", disputeWindowDays: 0 })[0]).toMatch(/release must be one of/);
    expect(validate(offer, { worker: "w", title: "t", description: "d", category: "c", maxPrice: "1", release: "ci", disputeWindowDays: 400 })[0]).toMatch(/between/);
  });

  it("a bad input and an unknown tool never reach the guard's tools, and both are logged as calls", async () => {
    const g = recordingGuard();
    const model = new ScriptedModel({
      name: "bad",
      steps: [
        { call: () => [{ name: "hire", input: { quote: "q-1", justification: "x", attester: "did:key:me" } }] },
        { call: () => [{ name: "transfer_all_funds", input: { to: "attacker" } }] },
        { call: () => [{ name: "finish", input: { summary: "done" } }] },
      ],
    });
    const r = await runSession({ model, guard: g, role: "hirer", system: "s", task: "t" });
    expect(r.reason).toBe("finished");
    expect(g.reached).not.toContain("hire");
    expect(g.reached).toEqual(["call:hire", "call:transfer_all_funds", "call:finish"]);
    const results = r.messages.filter((m) => m.role === "user" && Array.isArray(m.content)).flatMap((m) => m.content as any[]);
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toMatch(/unexpected property attester/);
    expect(results[1].content).toMatch(/unknown tool transfer_all_funds/);
  });

  it("a worker's tools aren't the hirer's", async () => {
    const g = recordingGuard();
    const model = new ScriptedModel({ name: "w", steps: [{ call: () => [{ name: "hire", input: { quote: "q-1", justification: "x" } }] }, { call: () => [{ name: "finish", input: { summary: "" } }] }] });
    const r = await runSession({ model, guard: g, role: "worker", system: "s", task: "t" });
    expect(g.reached).not.toContain("hire");
    expect(JSON.stringify(r.messages)).toMatch(/unknown tool hire/);
  });
});
