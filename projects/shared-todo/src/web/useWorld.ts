import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { World } from "../todo/world";

/** Holds the demo's World and re-renders on every change in it. "Previous" rebuilds and replays. */
export function useWorld(loadPolicy: () => Promise<BufferSource>) {
  const [world, setWorld] = useState<World | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const wasm = useRef<Promise<BufferSource> | null>(null);

  const build = useCallback(
    async (upTo: number) => {
      try {
        wasm.current ??= loadPolicy();
        const w = await World.create({ policyWasm: await wasm.current });
        for (let n = 1; n <= upTo; n++) await w.runStep(n);
        setWorld(w);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [loadPolicy],
  );

  useEffect(() => {
    void build(1);
  }, [build]);

  useEffect(() => (world ? world.subscribe(bump) : undefined), [world]);

  const next = useCallback(async () => {
    if (!world || world.busy) return;
    try {
      await world.runStep(world.stepIndex + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [world]);

  const previous = useCallback(() => build(Math.max(1, (world?.stepIndex ?? 1) - 1)), [build, world]);
  const reset = useCallback(() => build(1), [build]);

  /** Runs a free-play action and waits for every message it causes. */
  const perform = useCallback(
    async (fn: () => Promise<unknown> | unknown) => {
      if (!world) return;
      await fn();
      await world.settle();
      bump();
    },
    [world],
  );

  return { world, error, next, previous, reset, perform };
}
