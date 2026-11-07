// Finds every Trust Task type defined in the repository with ourSpec("<name>"), and joins it with
// the hand-checked notes in src/data/spec-notes.json. Payload shapes are extracted from the code.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_DIR, SITE_DIR } from "./config";
import { githubSlug } from "./html";

export interface SpecNote {
  purpose: string;
  from: string;
  to: string;
  kind: "one-way" | "request/response";
  payloadType?: string;
  payloadInline?: string;
  payloadFile?: string;
  responseType?: string;
  responseInline?: string;
  responseFile?: string;
  related?: { type: string; file: string }[];
  design: string;
  designSection: string;
  handledIn?: string[];
  note?: string;
}

export interface Decl {
  name: string;
  file: string;
  line: number;
  text: string;
}

export interface Spec {
  name: string;
  family: string;
  file: string;
  line: number;
  constName?: string;
  doc?: string;
  fileDoc?: string;
  note?: SpecNote;
  payload?: { text: string; decl?: Decl };
  response?: { text: string; decl?: Decl };
  related: Decl[];
  designAnchor?: string;
}

export const warnings: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "tests" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const top of ["packages", "projects"]) {
    const root = join(REPO_DIR, top);
    if (!existsSync(root)) continue;
    for (const pkg of readdirSync(root)) walk(join(root, pkg, "src"), files);
  }
  return files;
}

const docText = (c: string) =>
  c
    .split("\n")
    .map((l) => l.replace(/^\s*\/?\*+\/?\s?/, "").replace(/\*\/\s*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/** The /** comment that ends on the line just above `lineIdx`, if any. */
function docAbove(lines: string[], lineIdx: number): string | undefined {
  let i = lineIdx - 1;
  if (i < 0 || !lines[i].trim().endsWith("*/")) return undefined;
  const end = i;
  while (i >= 0 && !lines[i].includes("/**")) i--;
  if (i < 0) return undefined;
  return docText(lines.slice(i, end + 1).join("\n"));
}

/** A file's leading /** comment, after its imports. */
function fileDoc(src: string): string | undefined {
  const m = src.match(/^(?:import[^\n]*\n|\s*\n)*\s*\/\*\*([\s\S]*?)\*\//);
  return m ? docText(m[0].slice(m[0].indexOf("/**"))) : undefined;
}

export function extractDecl(file: string, name: string): Decl | undefined {
  const abs = join(REPO_DIR, file);
  if (!existsSync(abs)) return undefined;
  const src = readFileSync(abs, "utf8");
  const re = new RegExp(`^(?:export\\s+)?(?:interface|type)\\s+${name}\\b[^\\n]*`, "m");
  const m = re.exec(src);
  if (!m) return undefined;
  let start = m.index;
  // Include a doc comment directly above.
  const before = src.slice(0, start);
  const open = before.lastIndexOf("/**");
  if (open >= 0 && /^\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*$/.test(before.slice(open))) start = open;
  const isInterface = /^interface/.test(m[0].replace(/^export\s+/, ""));
  let i = m.index + m[0].indexOf(name) + name.length;
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "(" || ch === "[" || ch === "<") depth++;
    else if (ch === "}" || ch === ")" || ch === "]" || (ch === ">" && src[i - 1] !== "=")) {
      depth--;
      if (depth === 0 && ch === "}" && isInterface) {
        i++;
        break;
      }
    } else if (ch === ";" && depth === 0 && !isInterface) {
      i++;
      break;
    }
  }
  const text = src.slice(start, i).trimEnd();
  const line = src.slice(0, m.index).split("\n").length;
  return { name, file, line, text };
}

function headingsOf(file: string): Set<string> {
  const abs = join(REPO_DIR, file);
  if (!existsSync(abs)) return new Set();
  const out = new Set<string>();
  let inFence = false;
  for (const l of readFileSync(abs, "utf8").split("\n")) {
    if (/^```/.test(l)) inFence = !inFence;
    if (!inFence && /^#{1,6} /.test(l)) out.add(l.replace(/^#+ /, "").trim());
  }
  return out;
}

export function currentSpecBase(): string {
  const src = readFileSync(join(REPO_DIR, "packages/trust-core/src/tasks.ts"), "utf8");
  return src.match(/OUR_SPEC_BASE\s*=\s*"([^"]+)"/)?.[1] ?? "";
}

export function loadSpecs(): Spec[] {
  const notes = JSON.parse(readFileSync(join(SITE_DIR, "src/data/spec-notes.json"), "utf8")) as Record<string, SpecNote | string>;
  const found = new Map<string, Spec>();
  for (const abs of sourceFiles()) {
    const src = readFileSync(abs, "utf8");
    if (!src.includes("ourSpec(")) continue;
    const lines = src.split("\n");
    const file = relative(REPO_DIR, abs);
    const fdoc = fileDoc(src);
    lines.forEach((l, idx) => {
      const t = l.trim();
      if (t.startsWith("*") || t.startsWith("/*") || t.startsWith("//")) return;
      for (const m of l.matchAll(/ourSpec\("([^"]+)"\)/g)) {
        const name = m[1];
        if (found.has(name)) continue;
        const cm = l.match(/(?:const\s+)?(\w+)\s*(?::\s*\w+)?\s*[=:]\s*ourSpec\(/);
        found.set(name, {
          name,
          family: name.split("/")[0],
          file,
          line: idx + 1,
          constName: cm?.[1],
          doc: ((d) => (d && d !== fdoc ? d : undefined))(docAbove(lines, idx)),
          fileDoc: fdoc,
          related: [],
        });
      }
    });
  }

  for (const spec of found.values()) {
    const n = notes[spec.name];
    if (!n || typeof n === "string") {
      warnings.push(`spec ${spec.name} (${spec.file}:${spec.line}) has no entry in src/data/spec-notes.json`);
      continue;
    }
    spec.note = n;
    const decl = (type?: string, file?: string) => {
      if (!type || !file) return undefined;
      const d = extractDecl(file, type);
      if (!d) warnings.push(`spec ${spec.name}: can't find ${type} in ${file}`);
      return d;
    };
    if (n.payloadType) {
      const d = decl(n.payloadType, n.payloadFile);
      spec.payload = { text: d?.text ?? n.payloadType, decl: d };
    } else if (n.payloadInline) spec.payload = { text: n.payloadInline };
    if (n.responseType) {
      const d = decl(n.responseType, n.responseFile);
      spec.response = { text: d?.text ?? n.responseType, decl: d };
    } else if (n.responseInline) spec.response = { text: n.responseInline };
    for (const r of n.related ?? []) {
      const d = decl(r.type, r.file);
      if (d) spec.related.push(d);
    }
    const heads = headingsOf(n.design);
    if (!heads.has(n.designSection)) warnings.push(`spec ${spec.name}: no heading "${n.designSection}" in ${n.design}`);
    else spec.designAnchor = githubSlug(n.designSection);
  }
  for (const name of Object.keys(notes)) {
    if (name.startsWith("$")) continue;
    if (!found.has(name)) warnings.push(`spec-notes.json has ${name}, which the code no longer defines`);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
