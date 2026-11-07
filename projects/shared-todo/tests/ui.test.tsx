// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, inject, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { Policies, SystemClock } from "@toip-tools/trust-core";
import { Device } from "../src/todo/device";
import { MemoryStore } from "../src/todo/store";
import { App } from "../src/web/App";
import { policyWasm } from "./helpers";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const c of closers.splice(0)) await c();
});

it("goes from first run to a list with an item", async () => {
  const relay = { url: inject("relayUrl") };
  const policies = await Policies.load(policyWasm());
  const store = new MemoryStore();
  const boot = async (name?: string) => {
    const d = await Device.open({ store, relayUrl: relay.url, policies, clock: new SystemClock(), name, webSocket: NodeWebSocket as unknown as typeof WebSocket });
    if (d) closers.unshift(() => d.close());
    return d;
  };
  render(<App boot={boot} inviteBase="http://localhost/" />);
  fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Alice" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
  await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy(), { timeout: 4000 });
  fireEvent.click(screen.getAllByRole("button", { name: "New list" })[0]);
  fireEvent.change(screen.getByLabelText("List name"), { target: { value: "Groceries" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create list" })));
  await screen.findByRole("heading", { name: "Groceries" });
  fireEvent.change(screen.getByLabelText("New item"), { target: { value: "Milk" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
  await screen.findByText("Milk");
  fireEvent.click(screen.getByRole("button", { name: "Show what's happening" }));
  await screen.findByText(/What the relay sees/);
}, 15000);
