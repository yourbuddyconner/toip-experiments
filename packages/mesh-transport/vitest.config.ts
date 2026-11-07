import { defineConfig } from "vitest/config";

export default defineConfig({
  // The gateway tests run a real relay; the default 5 s is too tight when the whole repository is tested at once.
  test: { testTimeout: 20000 },
});
