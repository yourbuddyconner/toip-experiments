import { test } from "node:test";
import assert from "node:assert/strict";
import { lineTotal, total } from "../src/invoice.js";

test("a line is its price times its quantity", () => {
  assert.equal(lineTotal({ price: 250, quantity: 2 }), 500);
});

test("an invoice adds up its lines", () => {
  assert.equal(total([{ price: 250, quantity: 2 }, { price: 100, quantity: 1 }]), 600);
});
