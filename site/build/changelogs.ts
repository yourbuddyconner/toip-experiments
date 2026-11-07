// Releases, read from each library's CHANGELOG.md (written by Changesets). The releases page and the
// Atom feed both come from here. A release's date is the date of the commit that added its heading.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR } from "./config";
import { libraries } from "../src/data/libraries";

export interface Release {
  library: string;
  name: string;
  version: string;
  /** ISO date of the commit that added this version's heading, if committed. */
  date?: string;
  /** The changelog section, as Markdown, without its version heading. */
  notes: string;
}

function headingDate(file: string, version: string): string | undefined {
  const r = spawnSync("git", ["log", "--format=%cI", "-S", `## ${version}`, "--", file], { cwd: REPO_DIR, encoding: "utf8" });
  const dates = r.status === 0 ? r.stdout.trim().split("\n").filter(Boolean) : [];
  return dates.at(-1);
}

export function loadReleases(): Release[] {
  const out: Release[] = [];
  for (const lib of libraries) {
    const rel = join(lib.dir, "CHANGELOG.md");
    const file = join(REPO_DIR, rel);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const sections = text.split(/^## /m).slice(1);
    for (const s of sections) {
      const nl = s.indexOf("\n");
      const version = s.slice(0, nl).trim();
      if (!/^\d+\.\d+\.\d+/.test(version)) continue;
      const notes = s.slice(nl + 1).trim();
      out.push({ library: lib.slug, name: lib.name, version, date: headingDate(rel, version), notes });
    }
  }
  return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.name.localeCompare(b.name));
}
