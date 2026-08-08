import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scope strictly to Jarvis's own tests. `.research/` holds upstream clones
    // (hermes-agent, jarvis-demo) that ship thousands of their own tests.
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".research/**", "dist/**", "out/**"],
    environment: "node",
  },
});
