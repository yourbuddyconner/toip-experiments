import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { startRelay } from "@toip-tools/relay";

/** One relay for tests that run in jsdom, which can't load node:sqlite themselves. */
export default async function setup(project: TestProject) {
  const relay = await startRelay({ port: 0, dbPath: join(mkdtempSync(join(tmpdir(), "ui-relay-")), "r.db") });
  project.provide("relayUrl", relay.url);
  return () => relay.close();
}

declare module "vitest" {
  export interface ProvidedContext {
    relayUrl: string;
  }
}
