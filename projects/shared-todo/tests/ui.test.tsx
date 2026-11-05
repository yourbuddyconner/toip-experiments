// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/web/App";

const load = async () => readFileSync(resolve(__dirname, "../policies/policy.wasm"));

describe("App", () => {
  it("renders five panes and steps through the script", async () => {
    render(<App loadPolicy={load} />);
    await screen.findByRole("heading", { name: "Alice" });
    for (const n of ["Alice", "Bob", "Carol", "Mallory", "Relay"]) expect(screen.getByRole("heading", { name: n })).toBeTruthy();
    expect(screen.getByText("Everyone has an identity")).toBeTruthy();
    const next = screen.getByRole("button", { name: "Next step" });
    await act(async () => next.click());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Alice creates the list" })).toBeTruthy());
    const alice = screen.getByRole("region", { name: "Alice's phone" });
    await waitFor(() => expect(within(alice).getByText("Maple St House")).toBeTruthy());
  });
});
