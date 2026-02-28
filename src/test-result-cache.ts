/**
 * TestResultCache — Content-addressable cache for test results.
 *
 * Wallaby-style instant results: if a test file has the exact same content
 * as a previous run, the cached results are replayed instantly without
 * spawning any test process.
 *
 * Cache key:  SHA-256 hash of the test file content.
 * Cache value: The full pipeline result (resolution, discovered tests,
 *              test results, collected results, console logs).
 *
 * Limitations (V1):
 * - Only the test file content is hashed. Changes to imported source files
 *   will NOT invalidate the cache. The user can manually reset the cache
 *   or use the "Wallacy: Reset Cache" command.
 * - Future versions can incorporate dependency graph hashes.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import {Service} from "typedi";
import type {CollectedResults, ConsoleLogEntry, SmartStartResult, TestInfo, TestResult} from "./shared-types";

// ─── Types ──────────────────────────────────────────────────

export interface CachedTestRun {
  /** SHA-256 hash of the test file content at the time of the run */
  contentHash: string;
  /** Absolute path to the test file */
  filePath: string;
  /** Timestamp when the result was cached */
  cachedAt: number;
  /** The full pipeline result */
  resolution: SmartStartResult;
  tests: TestInfo[];
  results: TestResult[];
  collected: CollectedResults;
  consoleLogs: ConsoleLogEntry[];
}

export interface CacheStats {
  /** Number of entries in the cache */
  size: number;
  /** Number of cache hits since last reset */
  hits: number;
  /** Number of cache misses since last reset */
  misses: number;
}

// ─── TestResultCache ────────────────────────────────────────

@Service()
export class TestResultCache {
  /**
   * Map from absolute file path → cached run.
   * We store one entry per file path; the contentHash inside
   * determines whether the cache is still valid.
   */
  private readonly cache = new Map<string, CachedTestRun>();

  private hits = 0;
  private misses = 0;

  // ─── Public API ─────────────────────────────────────────

  /**
   * Look up a cached result for the given file.
   * Returns the cached run if the file content hasn't changed, or null.
   */
  lookup(filePath: string): CachedTestRun | null {
    const entry = this.cache.get(filePath);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Compute the current content hash and compare
    const currentHash = this.hashFile(filePath);
    if (currentHash === null || currentHash !== entry.contentHash) {
      // File changed or unreadable — cache miss, evict stale entry
      this.cache.delete(filePath);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry;
  }

  /**
   * Store a test run result in the cache.
   */
  store(
    filePath: string,
    resolution: SmartStartResult,
    tests: TestInfo[],
    results: TestResult[],
    collected: CollectedResults,
    consoleLogs: ConsoleLogEntry[],
  ): void {
    const contentHash = this.hashFile(filePath);
    if (contentHash === null) {
      return; // Can't cache if we can't read the file
    }

    this.cache.set(filePath, {
      contentHash,
      filePath,
      cachedAt: Date.now(),
      resolution,
      tests,
      results,
      collected,
      consoleLogs,
    });
  }

  /**
   * Invalidate a specific file's cache entry.
   */
  invalidate(filePath: string): boolean {
    return this.cache.delete(filePath);
  }

  /**
   * Clear the entire cache and reset statistics.
   */
  reset(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
    };
  }

  /**
   * Check if a file has a valid cache entry without counting it as a hit/miss.
   */
  has(filePath: string): boolean {
    const entry = this.cache.get(filePath);
    if (!entry) {
      return false;
    }
    const currentHash = this.hashFile(filePath);
    return currentHash !== null && currentHash === entry.contentHash;
  }

  // ─── Private ────────────────────────────────────────────

  /**
   * Compute SHA-256 hash of a file's content.
   * Returns null if the file can't be read.
   */
  private hashFile(filePath: string): string | null {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return this.hashContent(content);
    } catch {
      return null;
    }
  }

  /**
   * Compute SHA-256 hash of a string.
   * Exported for testing.
   */
  hashContent(content: string): string {
    return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  }
}
