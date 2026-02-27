/**
 * Integration tests for VitestAdapter.
 *
 * These tests create real filesystem fixtures with actual test files,
 * then use VitestAdapter.executeTests() to run them via the Vitest Node API
 * and verify the returned TestResult[] matches expectations.
 *
 * NOTE: This is "vitest inside vitest" — we're using vitest as our test runner
 * AND testing VitestAdapter which itself spawns a vitest instance. The inner
 * vitest instance gets its own config/root, so they don't conflict.
 *
 * We pass `configPath: null` so the adapter uses `config: false` — the inner
 * vitest doesn't look for a config file in the temp dir (which has no
 * node_modules). The test include patterns are passed programmatically.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import type {ExecutionOptions, LifecycleHooks, TestResult} from "../shared-types";
import {VitestAdapter} from "../test-adapters/vitest/vitest.adapter";

// ─── Helpers ────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wallacy-vitest-adapter-"));
}

function writeFile(dir: string, relativePath: string, content: string): string {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), {recursive: true});
  fs.writeFileSync(fullPath, content, "utf-8");
  return fullPath;
}

function cleanup(dir: string): void {
  // Retry cleanup on Windows — vitest may briefly hold file locks after close
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.rmSync(dir, {recursive: true, force: true});
      return;
    } catch {
      if (attempt < 2) {
        // Busy wait briefly to let file handles release
        const end = Date.now() + 200;
        while (Date.now() < end) {
          /* spin */
        }
      }
      // On last attempt, just swallow — OS will clean up temp dir
    }
  }
}

function makeOptions(projectRoot: string): ExecutionOptions {
  return {
    projectRoot,
    configPath: null,
    instrumentation: {
      lineCoverage: false,
      branchCoverage: false,
      valueCapture: false,
      importTracing: false,
      functionTracing: false,
    },
    timeout: 30_000,
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe("VitestAdapter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ─── discoverTests ──────────────────────────────────────

  describe("discoverTests", () => {
    it("should discover test files by glob pattern", async () => {
      writeFile(tmpDir, "src/math.test.ts", "// test");
      writeFile(tmpDir, "src/utils.spec.ts", "// spec");
      writeFile(tmpDir, "src/helper.ts", "// not a test");

      const adapter = new VitestAdapter();
      const tests = await adapter.discoverTests(tmpDir, null);

      const fileNames = tests.map((t) => path.basename(t.file));
      expect(fileNames).toContain("math.test.ts");
      expect(fileNames).toContain("utils.spec.ts");
      expect(fileNames).not.toContain("helper.ts");
    });

    it("should skip node_modules directories", async () => {
      writeFile(tmpDir, "node_modules/pkg/index.test.ts", "// should be ignored");
      writeFile(tmpDir, "src/real.test.ts", "// real test");

      const adapter = new VitestAdapter();
      const tests = await adapter.discoverTests(tmpDir, null);

      expect(tests.length).toBe(1);
      expect(path.basename(tests[0].file)).toBe("real.test.ts");
    });
  });

  // ─── executeTests — passing tests ────────────────────────

  describe("executeTests", () => {
    it("should run a passing test file and return passed results", async () => {
      const testFile = writeFile(
        tmpDir,
        "src/add.test.ts",
        `
import { describe, it, expect } from "vitest";

describe("add", () => {
  it("should add two numbers", () => {
    expect(1 + 2).toBe(3);
  });

  it("should handle zero", () => {
    expect(0 + 0).toBe(0);
  });
});
`,
      );

      const adapter = new VitestAdapter();
      const results = await adapter.executeTests([testFile], makeOptions(tmpDir));

      // Should have 2 test results
      expect(results.length).toBe(2);

      // All should be passed
      for (const r of results) {
        expect(r.status).toBe("passed");
        expect(r.error).toBeUndefined();
        expect(r.duration).toBeGreaterThanOrEqual(0);
        expect(r.name).toBeTruthy();
      }

      // Check test names
      const names = results.map((r) => r.name);
      expect(names).toContain("should add two numbers");
      expect(names).toContain("should handle zero");

      // Check suite chain
      for (const r of results) {
        expect(r.suite).toEqual(["add"]);
      }

      // File path should be set
      for (const r of results) {
        expect(r.file).toBeTruthy();
      }
    });

    it("should run a failing test and return failed results with error info", async () => {
      const testFile = writeFile(
        tmpDir,
        "src/fail.test.ts",
        `
import { describe, it, expect } from "vitest";

describe("failing suite", () => {
  it("should fail", () => {
    expect(1 + 1).toBe(99);
  });
});
`,
      );

      const adapter = new VitestAdapter();
      const results = await adapter.executeTests([testFile], makeOptions(tmpDir));

      expect(results.length).toBe(1);
      const [failed] = results;
      expect(failed.status).toBe("failed");
      expect(failed.name).toBe("should fail");
      expect(failed.suite).toEqual(["failing suite"]);
      expect(failed.error).toBeDefined();
      expect(failed.error!.message).toBeTruthy();
    });

    it("should handle mixed passing and failing tests", async () => {
      const testFile = writeFile(
        tmpDir,
        "src/mixed.test.ts",
        `
import { describe, it, expect } from "vitest";

describe("mixed", () => {
  it("passes", () => {
    expect(true).toBe(true);
  });

  it("fails", () => {
    expect(true).toBe(false);
  });
});
`,
      );

      const adapter = new VitestAdapter();
      const results = await adapter.executeTests([testFile], makeOptions(tmpDir));

      expect(results.length).toBe(2);
      const passed = results.find((r) => r.name === "passes");
      const failed = results.find((r) => r.name === "fails");

      expect(passed).toBeDefined();
      expect(passed!.status).toBe("passed");
      expect(failed).toBeDefined();
      expect(failed!.status).toBe("failed");
    });

    it("should handle skipped tests", async () => {
      const testFile = writeFile(
        tmpDir,
        "src/skip.test.ts",
        `
import { describe, it, expect } from "vitest";

describe("skipping", () => {
  it("runs", () => {
    expect(1).toBe(1);
  });

  it.skip("is skipped", () => {
    expect(1).toBe(2);
  });
});
`,
      );

      const adapter = new VitestAdapter();
      const results = await adapter.executeTests([testFile], makeOptions(tmpDir));

      expect(results.length).toBe(2);
      const running = results.find((r) => r.name === "runs");
      const skipped = results.find((r) => r.name === "is skipped");

      expect(running!.status).toBe("passed");
      expect(skipped!.status).toBe("skipped");
    });

    it("should handle nested describe blocks with correct suite chain", async () => {
      const testFile = writeFile(
        tmpDir,
        "src/nested.test.ts",
        `
import { describe, it, expect } from "vitest";

describe("outer", () => {
  describe("inner", () => {
    it("deep test", () => {
      expect(42).toBe(42);
    });
  });
});
`,
      );

      const adapter = new VitestAdapter();
      const results = await adapter.executeTests([testFile], makeOptions(tmpDir));

      expect(results.length).toBe(1);
      expect(results[0].name).toBe("deep test");
      expect(results[0].suite).toEqual(["outer", "inner"]);
      expect(results[0].status).toBe("passed");
    });

    it("should handle tests at root level (no describe block)", async () => {
      const testFile = writeFile(
        tmpDir,
        "src/root-level.test.ts",
        `
import { it, expect } from "vitest";

it("standalone test", () => {
  expect("hello").toBe("hello");
});
`,
      );

      const adapter = new VitestAdapter();
      const results = await adapter.executeTests([testFile], makeOptions(tmpDir));

      expect(results.length).toBe(1);
      expect(results[0].name).toBe("standalone test");
      expect(results[0].suite).toEqual([]);
      expect(results[0].status).toBe("passed");
    });

    it("should run multiple test files in a single call", async () => {
      const testFileA = writeFile(
        tmpDir,
        "src/a.test.ts",
        `
import { it, expect } from "vitest";
it("test A", () => { expect(1).toBe(1); });
`,
      );
      const testFileB = writeFile(
        tmpDir,
        "src/b.test.ts",
        `
import { it, expect } from "vitest";
it("test B", () => { expect(2).toBe(2); });
`,
      );

      const adapter = new VitestAdapter();
      const results = await adapter.executeTests([testFileA, testFileB], makeOptions(tmpDir));

      expect(results.length).toBe(2);
      const names = results.map((r) => r.name);
      expect(names).toContain("test A");
      expect(names).toContain("test B");
    });
  });

  // ─── Lifecycle hooks ─────────────────────────────────────

  describe("lifecycle hooks", () => {
    it("should invoke onTestEnd for each test result", async () => {
      writeFile(
        tmpDir,
        "src/hooks.test.ts",
        `
import { describe, it, expect } from "vitest";
describe("hooks suite", () => {
  it("test one", () => { expect(1).toBe(1); });
  it("test two", () => { expect(2).toBe(2); });
});
`,
      );

      const streamed: TestResult[] = [];
      const hooks: LifecycleHooks = {
        onTestEnd: (result) => streamed.push(result),
      };

      const adapter = new VitestAdapter();
      adapter.hookIntoLifecycle(hooks);
      await adapter.executeTests([path.join(tmpDir, "src/hooks.test.ts")], makeOptions(tmpDir));

      expect(streamed.length).toBe(2);
      const names = streamed.map((r) => r.name);
      expect(names).toContain("test one");
      expect(names).toContain("test two");
    });

    it("should invoke onFileStart and onFileEnd", async () => {
      writeFile(
        tmpDir,
        "src/filelife.test.ts",
        `
import { it, expect } from "vitest";
it("file lifecycle test", () => { expect(true).toBe(true); });
`,
      );

      const fileStarts: string[] = [];
      const fileEnds: string[] = [];
      const hooks: LifecycleHooks = {
        onFileStart: (f) => fileStarts.push(f),
        onFileEnd: (f) => fileEnds.push(f),
      };

      const adapter = new VitestAdapter();
      adapter.hookIntoLifecycle(hooks);
      await adapter.executeTests([path.join(tmpDir, "src/filelife.test.ts")], makeOptions(tmpDir));

      expect(fileStarts.length).toBe(1);
      expect(fileEnds.length).toBe(1);
    });
  });

  // ─── collectResults ──────────────────────────────────────

  describe("collectResults", () => {
    it("should return accumulated results after executeTests", async () => {
      writeFile(
        tmpDir,
        "src/collect.test.ts",
        `
import { it, expect } from "vitest";
it("collected test", () => { expect(1).toBe(1); });
`,
      );

      const adapter = new VitestAdapter();
      await adapter.executeTests([path.join(tmpDir, "src/collect.test.ts")], makeOptions(tmpDir));

      const collected = await adapter.collectResults();
      expect(collected.results.length).toBe(1);
      expect(collected.results[0].name).toBe("collected test");
      expect(collected.results[0].status).toBe("passed");
      expect(collected.duration).toBeGreaterThan(0);
    });
  });

  // ─── dispose ─────────────────────────────────────────────

  describe("dispose", () => {
    it("should clear accumulated results after dispose", async () => {
      writeFile(
        tmpDir,
        "src/dispose.test.ts",
        `
import { it, expect } from "vitest";
it("disposable test", () => { expect(1).toBe(1); });
`,
      );

      const adapter = new VitestAdapter();
      await adapter.executeTests([path.join(tmpDir, "src/dispose.test.ts")], makeOptions(tmpDir));

      // Before dispose
      let collected = await adapter.collectResults();
      expect(collected.results.length).toBe(1);

      // After dispose
      await adapter.dispose();
      collected = await adapter.collectResults();
      expect(collected.results.length).toBe(0);
      expect(collected.duration).toBe(0);
    });
  });

  // ─── Error handling ──────────────────────────────────────

  describe("error handling", () => {
    it("should handle non-existent project root gracefully", async () => {
      const adapter = new VitestAdapter();
      const options = makeOptions(path.join(tmpDir, "does-not-exist"));

      // Should not throw — should return error results
      const results = await adapter.executeTests([path.join(tmpDir, "does-not-exist", "fake.test.ts")], options);

      // We expect either empty results or synthetic error results
      // depending on how vitest handles the missing directory
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
