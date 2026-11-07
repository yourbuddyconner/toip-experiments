#!/usr/bin/env node
// Starts the relay. Configure with PORT (default 8787), RELAY_DB (default ./relay.db),
// RELAY_PUBLIC_URL (the URL clients use, e.g. wss://relay.example.com/v1) and HOST.
import { startRelay } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
const relay = await startRelay({
  port,
  host: process.env.HOST,
  dbPath: process.env.RELAY_DB ?? "relay.db",
  publicUrl: process.env.RELAY_PUBLIC_URL,
  log: (line) => console.log(`[relay] ${line}`),
});
console.log(`[relay] listening on port ${relay.port}; clients connect to ${relay.url}`);
const stop = async () => {
  await relay.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
