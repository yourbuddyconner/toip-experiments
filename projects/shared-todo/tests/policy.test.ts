import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Policies } from "@zk-toip/trust-core";
import { authorize, type AuthzInput } from "../src/todo/checks";

let policies: Policies;
beforeAll(async () => {
  policies = await Policies.load(readFileSync(new URL("../policies/policy.wasm", import.meta.url)));
});

const base = { isItemAuthor: false, itemPrivate: false, isReader: false };
const decide = (i: Partial<AuthzInput> & Pick<AuthzInput, "role" | "kind">) => authorize(policies, { ...base, ...i });

describe("role table (design 4.6)", () => {
  const table: [AuthzInput["role"], AuthzInput["kind"], boolean, Partial<AuthzInput>?][] = [
    ["admin", "add", true], ["editor", "add", true], ["viewer", "add", false],
    ["admin", "check", true], ["editor", "check", true], ["viewer", "check", false],
    ["admin", "uncheck", true], ["editor", "uncheck", true], ["viewer", "uncheck", false],
    ["admin", "edit", true], ["editor", "edit", true], ["viewer", "edit", false],
    ["admin", "delete", true], ["editor", "delete", false], ["editor", "delete", true, { isItemAuthor: true }], ["viewer", "delete", false],
    ["admin", "invite", true], ["editor", "invite", false], ["viewer", "invite", false],
    ["admin", "revoke", true], ["editor", "revoke", false], ["viewer", "revoke", false],
  ];
  for (const [role, kind, allow, extra] of table) {
    it(`${role} ${allow ? "may" : "may not"} ${kind}${extra ? " (own item)" : ""}`, () => {
      const d = decide({ role, kind, ...extra });
      expect(d.allow).toBe(allow);
      expect(d.reasons).toEqual(allow ? [] : [`${role} may not ${kind}`]);
    });
  }
});

describe("private items", () => {
  it("a non-reader editor may not check one", () => {
    expect(decide({ role: "editor", kind: "check", itemPrivate: true, isReader: false })).toEqual({ allow: false, reasons: ["not a reader of this item"] });
  });
  it("a reader editor may check one", () => {
    expect(decide({ role: "editor", kind: "check", itemPrivate: true, isReader: true }).allow).toBe(true);
  });
  it("a viewer reader still may not edit", () => {
    expect(decide({ role: "viewer", kind: "edit", itemPrivate: true, isReader: true })).toEqual({ allow: false, reasons: ["viewer may not edit"] });
  });
  it("an admin who is not a reader may not edit one", () => {
    expect(decide({ role: "admin", kind: "edit", itemPrivate: true, isReader: false }).reasons).toEqual(["not a reader of this item"]);
  });
});
