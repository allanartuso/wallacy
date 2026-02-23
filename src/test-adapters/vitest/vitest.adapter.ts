import * as path from "node:path";
import * as fs from "node:fs";
import type {
  TestInfo,
  TestResult,
  ExecutionOptions,
  LifecycleHooks,
  CollectedResults,
  TestFrameworkAdapter,
} from "../../shared-types";

export class VitestAdapter implements TestFrameworkAdapter {
  readonly name = "vitest" as const;
  private hooks: LifecycleHooks | null = null;

  /**
   * Discover tests in a project using fast glob — NO Vitest instance created here.
   * This avoids occupying worker resources for a lightweight file scan.
   */
  async discoverTests(
    projectRoot: string,
    _configPath: string | null,
  ): Promise<TestInfo[]> {
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
  async executeTests(
    testFiles: string[],
    options: ExecutionOptions,
  ): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const capturedHooks = this.hooks;

    const normalizedRoot = this.normalizePath(options.projectRoot);
    const normalizedConfig = options.configPath
      ? this.normalizePath(options.configPath)
      : undefined;

    // Convert input files to relative paths from project root
    const relFiles = testFiles.map((f) => {
      const abs = path.resolve(f);
      return path.relative(normalizedRoot, abs).replace(/\\/g, "/");
    });

    const originalCwd = process.cwd();
    try {
      process.chdir(normalizedRoot);
    } catch (err) {
      console.error(
        `[VitestAdapter] Failed to chdir to ${normalizedRoot}:`,
        err,
      );
    }

    try {
      console.log("Should start vitest");
      //   const vitest = await createVitest("test", {
      //     root: normalizedRoot,
      //     config: normalizedConfig,
      //     watch: false,
      //     coverage: { enabled: false },
      //     reporters: [
      //       "verbose",
      //       {
      //         onTaskUpdate: (packs: any[]) => {
      //           for (const [id, result, _meta] of packs) {
      //             const task = vitest.state.idMap.get(id);
      //             if (!task || task.type !== "test") continue;
      //             if (result?.state !== "pass" && result?.state !== "fail")
      //               continue;

      //             const testResult: TestResult = {
      //               testId: task.id,
      //               file: this.normalizePath((task as any).file?.filepath || ""),
      //               suite: this.buildSuiteChain(task),
      //               name: task.name,
      //               status: result.state === "pass" ? "passed" : "failed",
      //               duration: result.duration || 0,
      //               error: result.errors?.[0]
      //                 ? {
      //                     message:
      //                       result.errors[0].message ?? String(result.errors[0]),
      //                     stack: result.errors[0].stack,
      //                   }
      //                 : undefined,
      //               line: (task as any).location?.line,
      //             };

      //             results.push(testResult);
      //             capturedHooks?.onTestEnd?.(testResult);
      //           }
      //         },
      //       } as any,
      //     ],
      //     // RELATIVE paths are much safer for Vitest's internal matching on Windows
      //     include:
      //       relFiles.length > 0 ? relFiles : ["**/*.{test,spec}.{ts,js,tsx,jsx}"],
      //     exclude: ["**/node_modules/**", "**/dist/**"],
      //   });

      //   console.log(
      //     `[VitestAdapter][Diag] [v1.0.2] v${vitestVersion}, root: ${vitest.config.root}, relFiles: ${relFiles.join(", ")}`,
      //   );

      // Always call start with relative paths matching the 'include' filter
      //   await vitest.start(relFiles.length > 0 ? relFiles : undefined);

      // Collect any remaining results from state
      //   if (results.length === 0 && relFiles.length > 0) {
      //     console.log(
      //       `[VitestAdapter][Warning] Vitest reported success but 0 results. Files in state: ${vitest.state
      //         .getFiles()
      //         .map((f) => f.filepath)
      //         .join(", ")}`,
      //     );
      //   }

      //   for (const file of vitest.state.getFiles()) {
      //     const leafTasks = this.collectLeafTasks(file);
      //     if (leafTasks.length === 0 && file.result?.state === "fail") {
      //       const errorResult: TestResult = {
      //         testId: file.filepath,
      //         file: this.normalizePath(file.filepath),
      //         suite: [],
      //         name: "File Load Error",
      //         status: "failed",
      //         duration: 0,
      //         error: {
      //           message:
      //             file.result.errors?.[0]?.message ?? "Failed to load test file",
      //           stack: file.result.errors?.[0]?.stack,
      //         },
      //       };
      //       results.push(errorResult);
      //       capturedHooks?.onTestEnd?.(errorResult);
      //       continue;
      //     }

      //     for (const task of leafTasks) {
      //       if (task.result?.state !== "pass" && task.result?.state !== "fail")
      //         continue;
      //       const alreadyReported = results.some((r) => r.testId === task.id);
      //       if (!alreadyReported) {
      //         const testResult: TestResult = {
      //           testId: task.id,
      //           file: this.normalizePath((task as any).file?.filepath || ""),
      //           suite: this.buildSuiteChain(task),
      //           name: task.name,
      //           status: task.result.state === "pass" ? "passed" : "failed",
      //           duration: task.result.duration || 0,
      //           error: task.result.errors?.[0]
      //             ? { message: task.result.errors[0].message ?? "" }
      //             : undefined,
      //           line: (task as any).location?.line,
      //         };
      //         results.push(testResult);
      //         capturedHooks?.onTestEnd?.(testResult);
      //       }
      //     }
      //   }

      //   await vitest.close();
    } finally {
      // Restore original CWD
      try {
        process.chdir(originalCwd);
      } catch {}
    }

    return results;
  }

  async collectResults(): Promise<CollectedResults> {
    // Results are streamed via onTestEnd during executeTests
    return { results: [], coverage: [], duration: 0 };
  }

  async dispose(): Promise<void> {
    // Nothing to dispose — we close vitest in executeTests
  }

  // ─── Helpers ──────────────────────────────────────────────

  private normalizePath(p: string): string {
    const absolute = path.resolve(p);
    let normalized = absolute;
    if (
      process.platform === "win32" &&
      absolute.length > 1 &&
      absolute[1] === ":"
    ) {
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
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          ["node_modules", "dist", ".git", "coverage", ".nx"].includes(
            entry.name,
          )
        )
          continue;
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
