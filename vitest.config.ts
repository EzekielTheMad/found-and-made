import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    env: {
      PUBLIC_ORIGIN: "http://127.0.0.1:3000",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
    environment: "node",
    include: ["tests/**/*.test.ts"],
    maxWorkers: 8,
    testTimeout: 10_000,
  },
});
