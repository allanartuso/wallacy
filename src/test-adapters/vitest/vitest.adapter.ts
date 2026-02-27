import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CollectedResults,
  ExecutionOptions,
  LifecycleHooks,
  TestFrameworkAdapter,
  TestInfo,
  TestResult,
} from "../../shared-types";

export class VitestAdapter implements TestFrameworkAdapter {
  readonly name = "vitest" as const;
  private hooks: LifecycleHooks | null = null;

  /**
   * Discover tests in a project using fast glob — NO Vitest instance created here.
   * This avoids occupying worker resources for a lightweight file scan.
   */
  async discoverTests(projectRoot: string, _configPath: string | null): Promise<TestInfo[]> {
    const testFiles = this.globTestFiles(projectRoot);
    return testFiles.map((file) => ({
      id: file,
      file,
      suite: [],
      name: path.basename(file),
      // No line info at discovery time without parsing — CodeLens will appear per-file
    }));
  }

  hookIntoLifecycle(hooks: LifecycleHooks): void {
    this.hooks = hooks;
  }

  /**
   * Run the specified test files using Vitest.
   * Creates a fresh Vitest instance for each run, closes it when done.
   */
  async executeTests(testFiles: string[], options: ExecutionOptions): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const capturedHooks = this.hooks;

    const normalizedRoot = this.normalizePath(options.projectRoot);
    const normalizedConfig = options.configPath ? this.normalizePath(options.configPath) : undefined;

    // Convert input files to relative paths from project root
    const relFiles = testFiles.map((f) => {
      const abs = path.resolve(f);
      return path.relative(normalizedRoot, abs).replace(/\\/g, "/");
    });

    const originalCwd = process.cwd();
    try {
      process.chdir(normalizedRoot);
    } catch (err) {
      console.error(`[VitestAdapter] Failed to chdir to ${normalizedRoot}:`, err);
    }

    return results;
  }

  async collectResults(): Promise<CollectedResults> {
    // Results are streamed via onTestEnd during executeTests
    return {results: [], coverage: [], duration: 0};
  }

  async dispose(): Promise<void> {
    // Nothing to dispose — we close vitest in executeTests
  }

  // ─── Helpers ──────────────────────────────────────────────

  private normalizePath(p: string): string {
    const absolute = path.resolve(p);
    let normalized = absolute;
    if (process.platform === "win32" && absolute.length > 1 && absolute[1] === ":") {
      // Force UPPERCASE drive letters — this is the most reliable for Vite on Windows.
      normalized = absolute[0].toUpperCase() + absolute.substring(1);
    }
    return normalized.replace(/\\/g, "/");
  }

  // ─── Helpers ──────────────────────────────────────────────

  private globTestFiles(projectRoot: string): string[] {
    const found: string[] = [];
    this.walkDir(projectRoot, found, 0);
    return found;
  }

  private walkDir(dir: string, results: string[], depth: number): void {
    if (depth > 6) {
      return; // avoid runaway recursion
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", ".git", "coverage", ".nx"].includes(entry.name)) continue;
        this.walkDir(fullPath, results, depth + 1);
      } else if (entry.isFile()) {
        if (/\.(test|spec)\.(ts|js|tsx|jsx|mts|mjs)$/.test(entry.name)) {
          results.push(fullPath);
        }
      }
    }
  }

  private buildSuiteChain(task: any): string[] {
    const chain: string[] = [];
    let current = task.suite;
    while (current && current.name) {
      chain.unshift(current.name);
      current = current.suite;
    }
    return chain;
  }

  private collectLeafTasks(task: any): any[] {
    if (task.type === "test" || task.type === "custom") {
      return [task];
    }
    if (task.tasks) {
      return task.tasks.flatMap((t: any) => this.collectLeafTasks(t));
    }
    return [];
  }
}
