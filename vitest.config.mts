import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/integration-tests/**/*.test.ts"],
    setupFiles: ["src/integration-tests/setup.ts"],
    globals: true,
    testTimeout: 15000,
  },
});
