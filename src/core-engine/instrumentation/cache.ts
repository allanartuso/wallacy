// ============================================================
// InstrumentationCache — Content-hash based cache for
// instrumented files.
//
// WHY: AST parsing and transformation are CPU-intensive.
// By caching results based on the original file's hash, we
// can skip instrumentation for any file that hasn't changed
// since the last run.
// ============================================================

import { InstrumentedFile } from "../../shared-types";

export class InstrumentationCache {
  private cache = new Map<string, InstrumentedFile>();

  /**
   * Get an instrumented file from the cache if it exists and
   * the hash matches.
   */
  get(filePath: string, currentHash: string): InstrumentedFile | undefined {
    const cached = this.cache.get(filePath);
    if (cached && cached.originalHash === currentHash) {
      return cached;
    }
    return undefined;
  }

  /**
   * Put an instrumented file into the cache.
   */
  set(filePath: string, instrumented: InstrumentedFile): void {
    this.cache.set(filePath, instrumented);
  }

  /**
   * Remove a file from the cache.
   */
  remove(filePath: string): void {
    this.cache.delete(filePath);
  }

  /**
   * Clean the cache of files that no longer exist in the provided paths.
   */
  prune(validPaths: Set<string>): void {
    for (const path of this.cache.keys()) {
      if (!validPaths.has(path)) {
        this.cache.delete(path);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the total number of cached files.
   */
  get size(): number {
    return this.cache.size;
  }
}
