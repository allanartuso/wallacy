import path from "node:path";
import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/integration-tests/**/*.test.ts"],
    setupFiles: ["src/integration-tests/setup.ts"],
    globals: true,
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "src/integration-tests/__mocks__/vscode.ts"),
    },
  },
});
