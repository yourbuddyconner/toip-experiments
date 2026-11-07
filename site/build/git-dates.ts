// When each file in the repository last changed, from one `git log`. The sitemap's lastmod and the
// articles' dateModified come from here. CI checks out the full history (fetch-depth: 0) for this.
import { spawnSync } from "node:child_process";
import { REPO_DIR } from "./config";

let cache: Map<string, string> | undefined;

/** Repository-relative path to the ISO date of the last commit that touched it. Empty outside a git checkout. */
export function gitDates(): Map<string, string> {
  if (cache) return cache;
  cache = new Map();
  const r = spawnSync("git", ["log", "--format=%x01%cI", "--name-only", "--no-renames", "--diff-merges=first-parent"], {
    cwd: REPO_DIR,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) return cache;
  let date = "";
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("\x01")) date = line.slice(1).trim();
    else if (line && date && !cache.has(line)) cache.set(line, date);
  }
  return cache;
}

/** The latest commit date among these files and folders, or undefined when none of them is committed. */
export function lastModified(sources: string[]): string | undefined {
  const dates = gitDates();
  let best: string | undefined;
  const consider = (d: string | undefined) => {
    if (d && (!best || Date.parse(d) > Date.parse(best))) best = d;
  };
  for (const s of sources) {
    const path = s.replace(/^\/+|\/+$/g, "");
    consider(dates.get(path));
    const prefix = `${path}/`;
    for (const [file, d] of dates) if (file.startsWith(prefix)) consider(d);
  }
  return best;
}
