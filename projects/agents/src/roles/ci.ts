/**
 * The CI attester (design §10.2): deterministic. The hirer tells it what to check (agents/job/watch); the
 * worker tells it what was delivered (agents/job/deliver). It clones the repository at the delivered commit,
 * runs `node --test`, and attests on Settle: "complete" if it passes, "not-complete" if not, with the log's hash.
 * It only runs repositories it was set up for, and only its own command. (A real one needs a sandbox, §17.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Party } from "@zk-toip/settle/src/agents/party";
import { hex } from "@zk-toip/settle/src/agents/base";
import { termsHash } from "@zk-toip/settle/src/protocol/documents";
import { JOB_DELIVER, JOB_WATCH, type JobDeliver, type JobWatch } from "../protocol/tasks";
import { run } from "../guard/workspace";

export interface CiRun {
  job: string;
  commit: string;
  passed: boolean;
  logHash: string;
  at: string;
  output: string;
}

export class CiAttester {
  readonly runs: CiRun[] = [];
  private readonly watches = new Map<string, { job: string; from: string; check: JobWatch["check"] }>();
  private readonly deliveries = new Map<string, { from: string; d: JobDeliver }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly party: Party,
    private readonly o: { repos: string[]; onNote?: (t: string) => void },
  ) {}

  start(): void {
    this.party.endpoint.handle<JobWatch, void>(JOB_WATCH, async (doc, { sender }) => {
      const w = doc.payload;
      if (typeof w?.termsHash !== "string" || w.check?.kind !== "ci" || !this.o.repos.includes(w.check.repo)) return;
      this.watches.set(w.termsHash, { job: String(w.job), from: sender, check: w.check });
      this.kick(w.termsHash);
    });
    this.party.endpoint.handle<JobDeliver, void>(JOB_DELIVER, async (doc, { sender }) => {
      const d = doc.payload;
      if (typeof d?.termsHash !== "string" || d.deliverable?.kind !== "git" || !/^[0-9a-f]{40}$/.test(d.deliverable.commit)) return;
      this.deliveries.set(d.termsHash, { from: sender, d });
      this.kick(d.termsHash);
    });
  }

  /** Not awaited by the handler: runs in this attester's own queue. */
  private kick(h: string): void {
    this.queue = this.queue.then(() => this.check(h)).catch((e) => this.o.onNote?.(`CI couldn't run: ${String(e?.message ?? e)}`));
  }

  private async check(h: string): Promise<void> {
    const w = this.watches.get(h);
    const del = this.deliveries.get(h);
    if (!w || !del) return;
    const p = this.party.list().find((x) => x.role === "attester" && x.terms && hex(termsHash(x.terms)) === h);
    // Only the payer may ask for a check, only the payee may deliver, and only for a payment that names this attester.
    if (!p?.terms || p.terms.payer.did !== w.from || p.terms.payee.did !== del.from || del.d.deliverable.kind !== "git" || del.d.deliverable.repo !== w.check.repo) return;
    const commit = del.d.deliverable.commit;
    if (this.runs.some((r) => r.commit === commit && r.job === w.job)) return;
    this.deliveries.delete(h);
    const dir = mkdtempSync(join(tmpdir(), "agents-ci-"));
    try {
      this.o.onNote?.(`CI: cloning ${w.check.repo} at ${commit.slice(0, 7)} and running node --test`);
      let out = "";
      let passed = false;
      const c = await run("git", ["clone", "--quiet", w.check.repo, dir], tmpdir());
      if (c.code !== 0) out = c.out;
      else {
        const k = await run("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", commit], dir);
        if (k.code !== 0) out = k.out;
        else {
          const t = await run(process.execPath, ["--test"], dir, Math.min(w.check.timeoutSeconds, 120) * 1000);
          out = t.out;
          passed = t.code === 0;
        }
      }
      const logHash = `sha256:${createHash("sha256").update(out).digest("hex")}`;
      this.runs.push({ job: w.job, commit, passed, logHash, at: new Date().toISOString(), output: out.slice(-3000) });
      await this.party.attest(p.id, passed ? "complete" : "not-complete", `CI ${passed ? "passed" : "failed"} at ${commit.slice(0, 7)}, log ${logHash.slice(0, 19)}…`);
      this.o.onNote?.(`CI: ${passed ? "green" : "red"} at ${commit.slice(0, 7)}; attested "${passed ? "complete" : "not-complete"}"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
