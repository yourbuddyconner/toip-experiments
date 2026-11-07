/**
 * A worker agent's files (design §12.4): a fresh clone of the job's repository. File tools are confined to it;
 * paths are resolved and checked against its root. Tests run with `node --test` and a time limit.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const MAX_FILE = 200_000;

export function run(cmd: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? cwd, GIT_TERMINAL_PROMPT: "0", NODE_OPTIONS: "" } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      done({ code, out: `${stdout}${stderr}${err && !stdout && !stderr ? err.message : ""}` });
    });
  });
}

const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=Coder agent", "-c", "user.email=coder@byteworks.example", "-c", "commit.gpgsign=false", ...args], cwd);

export class Workspace {
  private dir?: string;
  private repo?: string;
  private branch?: string;

  constructor(private readonly base = mkdtempSync(join(tmpdir(), "agents-work-"))) {
    mkdirSync(base, { recursive: true });
  }

  get root(): string | undefined {
    return this.dir;
  }

  /** Clones `repo` for a job. */
  async open(job: string, repo: string): Promise<void> {
    const dir = join(this.base, job.replace(/[^\w-]/g, "_"));
    if (!existsSync(dir)) {
      const r = await git(this.base, "clone", "--quiet", repo, dir);
      if (r.code !== 0) throw new Error(`couldn't clone the job's repository: ${r.out.trim().split("\n")[0]}`);
    }
    this.dir = realpathSync(dir);
    this.repo = repo;
    this.branch = `job/${job.replace(/[^\w-]/g, "_")}`;
  }

  /** A path inside the workspace, or an error. No escaping the root, no touching .git. */
  private inside(p: string): string {
    if (!this.dir) throw new Error("no job's files are open yet");
    if (typeof p !== "string" || !p || p.includes("\0")) throw new Error("not a path");
    const full = resolve(this.dir, p);
    const rel = relative(this.dir, full);
    if (rel.startsWith("..") || rel === "" || resolve(this.dir, rel) !== full || rel.split(sep).includes(".git")) throw new Error(`${p} is outside the job's files`);
    if (existsSync(full) && realpathSync(full) !== full && !realpathSync(full).startsWith(this.dir + sep)) throw new Error(`${p} is outside the job's files`);
    return full;
  }

  read(p: string): string {
    const f = this.inside(p);
    if (!existsSync(f) || statSync(f).isDirectory()) throw new Error(`no file ${p}`);
    const text = readFileSync(f, "utf8");
    return text.length > MAX_FILE ? text.slice(0, MAX_FILE) : text;
  }

  write(p: string, text: string): number {
    const f = this.inside(p);
    if (typeof text !== "string" || text.length > MAX_FILE) throw new Error("the text is too long");
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
    return Buffer.byteLength(text);
  }

  async test(timeoutSeconds = 60): Promise<{ passed: boolean; output: string }> {
    if (!this.dir) throw new Error("no job's files are open yet");
    const r = await run(process.execPath, ["--test"], this.dir, timeoutSeconds * 1000);
    return { passed: r.code === 0, output: r.out.slice(-4000) };
  }

  /** Commits everything and pushes it to the job's branch. Returns the commit. */
  async commit(message: string): Promise<string> {
    if (!this.dir || !this.repo) throw new Error("no job's files are open yet");
    await git(this.dir, "add", "-A");
    const c = await git(this.dir, "commit", "--quiet", "--allow-empty", "-m", message.slice(0, 200));
    if (c.code !== 0) throw new Error(`couldn't commit: ${c.out.trim().split("\n")[0]}`);
    const head = (await git(this.dir, "rev-parse", "HEAD")).out.trim();
    const p = await git(this.dir, "push", "--quiet", "--force", "origin", `HEAD:refs/heads/${this.branch}`);
    if (p.code !== 0) throw new Error(`couldn't push: ${p.out.trim().split("\n")[0]}`);
    return head;
  }
}

/** A bare repository made from a directory, as the demo's "remote". */
export async function makeBareRepo(source: string, at: string): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "agents-seed-"));
  await run("cp", ["-R", `${source}/.`, work], work);
  await git(work, "init", "--quiet", "-b", "main");
  await git(work, "add", "-A");
  await git(work, "commit", "--quiet", "-m", "The demo repository, with a failing test");
  mkdirSync(dirname(at), { recursive: true });
  const r = await git(dirname(at), "clone", "--quiet", "--bare", work, at);
  if (r.code !== 0) throw new Error(`couldn't make the demo repository: ${r.out}`);
  return at;
}
