// Reads example files for display: whole (minus region markers) or one named region.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_DIR } from "./config";

const MARK = /^\s*\/\/ #(end)?region\b.*$/;

export function exampleSource(rel: string): string {
  return readFileSync(join(SITE_DIR, rel), "utf8")
    .split("\n")
    .filter((l) => !MARK.test(l))
    .join("\n")
    .trimEnd();
}

/** Every block between `// #region <name>` and `// #endregion`, joined. */
export function exampleRegion(rel: string, name: string): string {
  const lines = readFileSync(join(SITE_DIR, rel), "utf8").split("\n");
  const out: string[] = [];
  let on = false;
  for (const l of lines) {
    if (new RegExp(`^\\s*// #region ${name}\\b`).test(l)) on = true;
    else if (/^\s*\/\/ #endregion/.test(l)) on = false;
    else if (on) out.push(l);
  }
  if (!out.length) throw new Error(`no region ${name} in ${rel}`);
  return out.join("\n");
}

/** The comment lines at the top of a snippet, as prose, and the code after them. */
export function splitLeadComment(src: string): { lead: string; code: string } {
  const lines = src.split("\n");
  const lead: string[] = [];
  while (lines.length && lines[0].startsWith("//")) lead.push(lines.shift()!.replace(/^\/\/\s?/, ""));
  return { lead: lead.join(" "), code: lines.join("\n").replace(/^\n+/, "") };
}

export function exampleOutput(step: string): string {
  return readFileSync(join(SITE_DIR, "examples/quickstart/output", `${step}.txt`), "utf8").trimEnd();
}
