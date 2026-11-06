/** Command-line flags shared by the platform's scripts. */
import { join } from "node:path";

const argv = process.argv.slice(2);

/** `--name value` or `--name=value`. */
export function flag(name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
}

export const has = (name: string) => argv.includes(`--${name}`);

/** Where a platform for `cluster` keeps its data: --data, $SETTLE_DATA, or projects/settle/.data/<cluster>. */
export function dataDirFor(cluster: string): string {
  const slug = cluster.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9.-]+/g, "_");
  return flag("data") ?? process.env.SETTLE_DATA ?? join(import.meta.dirname, "..", "..", ".data", slug);
}
