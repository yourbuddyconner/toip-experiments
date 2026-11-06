import { defineConfig } from "vitest/config";

export default defineConfig({
  // Integration tests run real relays; the default 5 s is too tight when the whole repository is tested at once.
  test: { globalSetup: ["tests/globalSetup.ts"], testTimeout: 20000 },
});
