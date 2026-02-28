/**
 * Integration tests for TestResultCache.
 *
 * Tests the content-addressable caching mechanism:
 *   - SHA-256 hashing of file content
 *   - Cache lookup (hit/miss based on content hash)
 *   - Cache invalidation (manual + content change)
 *   - Cache reset
 *   - Statistics tracking
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import type {CollectedResults, ConsoleLogEntry, SmartStartResult, TestInfo, TestResult} from "../shared-types";
import {TestResultCache} from "../test-result-cache";

// ─── Helpers ────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wallacy-cache-test-"));
}

function writeFile(dir: string, relativePath: string, content: string): string {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), {recursive: true});
  fs.writeFileSync(fullPath, content, "utf-8");
  return fullPath;
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  } catch {
    // Ignore cleanup errors
  }
}

/** Build a minimal SmartStartResult for testing. */
function fakeResolution(projectName = "my-app"): SmartStartResult {
  return {
    project: {
      name: projectName,
      root: `apps/${projectName}`,
      sourceRoot: `apps/${projectName}/src`,
      targets: {},
      tags: [],
      implicitDependencies: [],
    },
    testFramework: "vitest",
    testTarget: "test",
    configPath: null,
    tsconfigPath: null,
    pathAliases: {},
    dependents: [],
  };
}

function fakeTests(file: string): TestInfo[] {
  return [
    {id: `${file}::should work`, file, suite: ["Calculator"], name: "should work", line: 5},
    {id: `${file}::should fail`, file, suite: ["Calculator"], name: "should fail", line: 10},
  ];
}

function fakeResults(file: string): TestResult[] {
  return [
    {testId: `${file}::should work`, file, suite: ["Calculator"], name: "should work", status: "passed", duration: 10},
    {
      testId: `${file}::should fail`,
      file,
      suite: ["Calculator"],
      name: "should fail",
      status: "failed",
      duration: 5,
      error: {message: "expected 1 to be 2"},
    },
  ];
}

function fakeCollected(file: string): CollectedResults {
  return {
    results: fakeResults(file),
    coverage: [],
    duration: 15,
  };
}

function fakeConsoleLogs(): ConsoleLogEntry[] {
  return [{stream: "stdout", content: "console.log from test", timestamp: Date.now()}];
}

// ─── Tests ──────────────────────────────────────────────────

describe("TestResultCache", () => {
  let tmpDir: string;
  let cache: TestResultCache;

  beforeEach(() => {
    tmpDir = createTempDir();
    cache = new TestResultCache();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ─── Hashing ─────────────────────────────────────────────

  describe("hashContent", () => {
    it("should produce a consistent SHA-256 hex hash", () => {
      const hash1 = cache.hashContent("hello world");
      const hash2 = cache.hashContent("hello world");
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
    });

    it("should produce different hashes for different content", () => {
      const hash1 = cache.hashContent("hello");
      const hash2 = cache.hashContent("world");
      expect(hash1).not.toBe(hash2);
    });
  });

  // ─── Lookup (miss) ───────────────────────────────────────

  describe("lookup — miss", () => {
    it("should return null for a file never cached", () => {
      const testFile = writeFile(tmpDir, "src/app.test.ts", "// test content");
      expect(cache.lookup(testFile)).toBeNull();
    });

    it("should return null for a non-existent file", () => {
      expect(cache.lookup("/nonexistent/file.ts")).toBeNull();
    });

    it("should increment miss count", () => {
      const testFile = writeFile(tmpDir, "src/app.test.ts", "// test");
      cache.lookup(testFile);
      cache.lookup(testFile);
      expect(cache.getStats().misses).toBe(2);
      expect(cache.getStats().hits).toBe(0);
    });
  });

  // ─── Store + Lookup (hit) ────────────────────────────────

  describe("store + lookup — hit", () => {
    it("should return cached result when file content is unchanged", () => {
      const testFile = writeFile(tmpDir, "src/calc.test.ts", 'describe("Calc", () => {})');
      const resolution = fakeResolution();
      const tests = fakeTests(testFile);
      const results = fakeResults(testFile);
      const collected = fakeCollected(testFile);
      const consoleLogs = fakeConsoleLogs();

      cache.store(testFile, resolution, tests, results, collected, consoleLogs);

      const cached = cache.lookup(testFile);

      expect(cached).not.toBeNull();
      expect(cached!.filePath).toBe(testFile);
      expect(cached!.resolution.project.name).toBe("my-app");
      expect(cached!.tests).toHaveLength(2);
      expect(cached!.results).toHaveLength(2);
      expect(cached!.results[0].status).toBe("passed");
      expect(cached!.results[1].status).toBe("failed");
      expect(cached!.collected.duration).toBe(15);
      expect(cached!.consoleLogs).toHaveLength(1);
      expect(cached!.contentHash).toHaveLength(64);
      expect(cached!.cachedAt).toBeGreaterThan(0);
    });

    it("should increment hit count on successful lookup", () => {
      const testFile = writeFile(tmpDir, "src/app.test.ts", "// test");
      cache.store(testFile, fakeResolution(), fakeTests(testFile), fakeResults(testFile), fakeCollected(testFile), []);

      cache.lookup(testFile);
      cache.lookup(testFile);
      cache.lookup(testFile);

      expect(cache.getStats().hits).toBe(3);
      expect(cache.getStats().misses).toBe(0);
    });
  });

  // ─── Content change invalidation ─────────────────────────

  describe("content change invalidation", () => {
    it("should return null when file content has changed since caching", () => {
      const testFile = writeFile(tmpDir, "src/calc.test.ts", "// original content");
      cache.store(testFile, fakeResolution(), fakeTests(testFile), fakeResults(testFile), fakeCollected(testFile), []);

      // Modify the file content
      fs.writeFileSync(testFile, "// modified content", "utf-8");

      const cached = cache.lookup(testFile);
      expect(cached).toBeNull();
    });

    it("should evict stale entry when content changes", () => {
      const testFile = writeFile(tmpDir, "src/calc.test.ts", "// v1");
      cache.store(testFile, fakeResolution(), fakeTests(testFile), fakeResults(testFile), fakeCollected(testFile), []);

      // Modify the file
      fs.writeFileSync(testFile, "// v2", "utf-8");
      cache.lookup(testFile); // miss — evicts stale entry

      // Now store with new content
      cache.store(testFile, fakeResolution(), fakeTests(testFile), fakeResults(testFile), fakeCollected(testFile), []);

      // Should hit on the new content
      const cached = cache.lookup(testFile);
      expect(cached).not.toBeNull();
    });

    it("should return null when file is deleted after caching", () => {
      const testFile = writeFile(tmpDir, "src/ephemeral.test.ts", "// temp");
      cache.store(testFile, fakeResolution(), fakeTests(testFile), fakeResults(testFile), fakeCollected(testFile), []);

      fs.unlinkSync(testFile);

      expect(cache.lookup(testFile)).toBeNull();
    });
  });

  // ─── Manual invalidation ─────────────────────────────────

  describe("invalidate", () => {
    it("should remove a specific file from the cache", () => {
      const file1 = writeFile(tmpDir, "src/a.test.ts", "// a");
      const file2 = writeFile(tmpDir, "src/b.test.ts", "// b");
      cache.store(file1, fakeResolution(), fakeTests(file1), fakeResults(file1), fakeCollected(file1), []);
      cache.store(file2, fakeResolution(), fakeTests(file2), fakeResults(file2), fakeCollected(file2), []);

      const removed = cache.invalidate(file1);

      expect(removed).toBe(true);
      expect(cache.lookup(file1)).toBeNull();
      expect(cache.lookup(file2)).not.toBeNull(); // file2 untouched
    });

    it("should return false when invalidating a file not in cache", () => {
      expect(cache.invalidate("/nonexistent/file.ts")).toBe(false);
    });
  });

  // ─── Reset ───────────────────────────────────────────────

  describe("reset", () => {
    it("should clear all entries and reset stats", () => {
      const file1 = writeFile(tmpDir, "src/a.test.ts", "// a");
      const file2 = writeFile(tmpDir, "src/b.test.ts", "// b");
      cache.store(file1, fakeResolution(), fakeTests(file1), fakeResults(file1), fakeCollected(file1), []);
      cache.store(file2, fakeResolution(), fakeTests(file2), fakeResults(file2), fakeCollected(file2), []);
      cache.lookup(file1); // hit
      cache.lookup("/nope"); // miss

      cache.reset();

      const stats = cache.getStats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(cache.lookup(file1)).toBeNull();
      expect(cache.lookup(file2)).toBeNull();
    });
  });

  // ─── has() ───────────────────────────────────────────────

  describe("has", () => {
    it("should return true when file is cached with matching content", () => {
      const testFile = writeFile(tmpDir, "src/app.test.ts", "// test");
      cache.store(testFile, fakeResolution(), fakeTests(testFile), fakeResults(testFile), fakeCollected(testFile), []);

      expect(cache.has(testFile)).toBe(true);
    });

    it("should return false when file is not cached", () => {
      expect(cache.has("/nonexistent")).toBe(false);
    });

    it("should return false when file content has changed", () => {
      const testFile = writeFile(tmpDir, "src/app.test.ts", "// original");
      cache.store(testFile, fakeResolution(), fakeTests(testFile), fakeResults(testFile), fakeCollected(testFile), []);

      fs.writeFileSync(testFile, "// changed", "utf-8");
      expect(cache.has(testFile)).toBe(false);
    });

    it("should not affect hit/miss counters", () => {
      const testFile = writeFile(tmpDir, "src/app.test.ts", "// test");
      cache.store(testFile, fakeResolution(), fakeTests(testFile), fakeResults(testFile), fakeCollected(testFile), []);

      cache.has(testFile);
      cache.has("/nonexistent");

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  // ─── Stats ───────────────────────────────────────────────

  describe("getStats", () => {
    it("should track size, hits, and misses accurately", () => {
      const file1 = writeFile(tmpDir, "src/a.test.ts", "// a");
      const file2 = writeFile(tmpDir, "src/b.test.ts", "// b");
      const file3 = writeFile(tmpDir, "src/c.test.ts", "// c");

      cache.store(file1, fakeResolution(), fakeTests(file1), fakeResults(file1), fakeCollected(file1), []);
      cache.store(file2, fakeResolution(), fakeTests(file2), fakeResults(file2), fakeCollected(file2), []);

      cache.lookup(file1); // hit
      cache.lookup(file2); // hit
      cache.lookup(file3); // miss (not cached)
      cache.lookup(file1); // hit

      const stats = cache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(1);
    });
  });

  // ─── Multiple files ──────────────────────────────────────

  describe("multiple files", () => {
    it("should cache multiple files independently", () => {
      const file1 = writeFile(tmpDir, "src/a.test.ts", 'describe("A", () => {})');
      const file2 = writeFile(tmpDir, "src/b.test.ts", 'describe("B", () => {})');

      cache.store(file1, fakeResolution("app-a"), fakeTests(file1), fakeResults(file1), fakeCollected(file1), []);
      cache.store(file2, fakeResolution("app-b"), fakeTests(file2), fakeResults(file2), fakeCollected(file2), []);

      const cached1 = cache.lookup(file1);
      const cached2 = cache.lookup(file2);

      expect(cached1).not.toBeNull();
      expect(cached2).not.toBeNull();
      expect(cached1!.resolution.project.name).toBe("app-a");
      expect(cached2!.resolution.project.name).toBe("app-b");
    });

    it("should update cache when file is stored again with same path but new content", () => {
      const testFile = writeFile(tmpDir, "src/app.test.ts", "// v1");
      cache.store(
        testFile,
        fakeResolution("v1"),
        fakeTests(testFile),
        fakeResults(testFile),
        fakeCollected(testFile),
        [],
      );

      // Overwrite the file
      fs.writeFileSync(testFile, "// v2", "utf-8");
      cache.store(
        testFile,
        fakeResolution("v2"),
        fakeTests(testFile),
        fakeResults(testFile),
        fakeCollected(testFile),
        [],
      );

      const cached = cache.lookup(testFile);
      expect(cached).not.toBeNull();
      expect(cached!.resolution.project.name).toBe("v2");
    });
  });
});
