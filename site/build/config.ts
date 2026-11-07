// Where the site is served. SITE_BASE wins; otherwise a CNAME in public/ means the custom domain at "/",
// and no CNAME means GitHub Pages' project path, /toip-tools/.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = join(SITE_DIR, "..");
export const OUT_DIR = join(SITE_DIR, "dist");

const cnameFile = join(SITE_DIR, "public", "CNAME");
const cname = existsSync(cnameFile) ? readFileSync(cnameFile, "utf8").trim() : "";

function normalizeBase(b: string): string {
  let s = b.trim() || "/";
  if (!s.startsWith("/")) s = `/${s}`;
  if (!s.endsWith("/")) s = `${s}/`;
  return s;
}

export const BASE = normalizeBase(process.env.SITE_BASE ?? (cname ? "/" : "/toip-tools/"));
export const ORIGIN = process.env.SITE_ORIGIN ?? (cname ? `https://${cname}` : "https://yourbuddyconner.github.io");

/** The domain the spec URIs live under, whatever the site is served from today. */
export const SPEC_ORIGIN = "https://toip.tools";

export const REPO = "https://github.com/yourbuddyconner/toip-tools";
export const CLONE = `${REPO}.git`;

/** A site-internal URL, with the base path. */
export function u(path: string): string {
  return BASE + path.replace(/^\//, "");
}

/** A file in the repository on GitHub. */
export function gh(path: string, anchor?: string): string {
  return `${REPO}/blob/main/${path}${anchor ? `#${anchor}` : ""}`;
}

/** A directory in the repository on GitHub. */
export function ghTree(path: string): string {
  return `${REPO}/tree/main/${path}`;
}
