// Records the SHA-256 of the compiled policy next to it, so tests can tell a stale build.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../policy/", import.meta.url);
const hash = createHash("sha256").update(readFileSync(new URL("policy.wasm", dir))).digest("hex");
writeFileSync(new URL("policy.sha256", dir), `sha256:${hash}\n`);
console.log(`sha256:${hash}`);
