import assert from "node:assert/strict";
import { before, test } from "node:test";
import { join } from "node:path";
import { SITE_DIR } from "./config";
import { readSdkModules, sdkEntryPoints, type ApiSymbol } from "./sdk-api";

let symbols: ApiSymbol[];
before(() => {
  const modules = readSdkModules([{
    library: "fixture", name: "fixture", file: join(SITE_DIR, "build/fixtures/sdk-api/index.ts"), subpath: ".", runtime: "Node",
  }], join(SITE_DIR, "tsconfig.sdk.json"));
  symbols = modules[0]?.symbols ?? [];
});

test("documents the public barrel, including aliases, without internal declarations", () => {
  assert.deepEqual(symbols.map(s => s.name).sort(), ["CONFIG", "Connection", "FactoryOnly", "Options", "echo", "formatLabel", "makeConnection", "ready"].sort());
});

test("extracts inferred returns, default arguments and documentation", () => {
  const symbol = symbols.find(s => s.name === "formatLabel");
  assert.ok(symbol, "The exported function should have a reference entry");
  assert.equal(symbol.signatures[0].returns, "string");
  assert.equal(symbol.signatures[0].parameters[1].defaultValue, '"sdk,{;}"');
  assert.equal(symbol.signatures[0].parameters[1].optional, true);
  assert.match(symbol.signatures[0].parameters[0].description, /value to format/);
  assert.match(symbol.description, /Formats a value/);
  assert.match(symbol.throws.join(" "), /empty/);
});

test("keeps overloads and recognizes exported arrow functions", () => {
  const overload = symbols.find(s => s.name === "echo");
  assert.ok(overload);
  assert.equal(overload.signatures.length, 2);
  assert.deepEqual(overload.signatures.map(s => s.returns).sort(), ["number", "string"]);
  assert.equal(symbols.find(s => s.name === "ready")?.kind, "function");
});

test("shows public instance and static methods, excluding private and protected members", () => {
  const symbol = symbols.find(s => s.name === "Connection");
  assert.ok(symbol);
  assert.ok(symbol.members.some(m => m.name === "send" && m.signatures[0].returns === "Promise<number>"));
  assert.ok(symbol.members.some(m => m.name === "open" && m.static));
  assert.ok(symbol.members.some(m => m.name === "close"));
  assert.ok(!symbol.members.some(m => ["secret", "internal", "prototype"].includes(m.name)));
});

test("documents option fields, source locations, and returned object methods", () => {
  const options = symbols.find(s => s.name === "Options");
  assert.ok(options);
  assert.ok(options.members.some(m => m.name === "timeoutMs" && m.optional && /milliseconds/.test(m.description)));
  assert.match(options.source.file, /fixtures\/sdk-api\/source\.ts$/);
  assert.ok(options.source.line > 0);
  const factory = symbols.find(s => s.name === "makeConnection");
  assert.ok(factory?.returnedMembers.some(m => m.name === "close"));
});

test("omits private constructors while preserving public factory methods", () => {
  const symbol = symbols.find(s => s.name === "FactoryOnly");
  assert.ok(symbol);
  assert.equal(symbol.signatures.length, 0);
  assert.ok(symbol.members.some(m => m.static && m.name === "create"));
  assert.equal(symbols.find(s => s.name === "Connection")?.signatures.length, 1);
});

test("discovers platform subpaths while excluding binary assets from the TypeScript API", () => {
  const entries = sdkEntryPoints();
  for (const name of ["@toip-tools/eventlog/node", "@toip-tools/anon-membership/worker", "@toip-tools/mesh-transport/sim", "@toip-tools/mesh-transport/node"]) {
    assert.ok(entries.some(entry => entry.name === name), `Missing package export ${name}`);
  }
  assert.ok(entries.every(entry => entry.file.endsWith(".ts")));
});
