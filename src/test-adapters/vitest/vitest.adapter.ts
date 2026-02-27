import * as fs from "node:fs";
import {createRequire} from "node:module";
import * as path from "node:path";
import {pathToFileURL} from "node:url";
import Container from "typedi";
import type {
  CollectedResults,
  ConsoleLogEntry,
  ExecutionOptions,
  LifecycleHooks,
  TestFrameworkAdapter,
  TestInfo,
  TestResult,
  TestStatus,
} from "../../shared-types";
import {VsCodeService} from "../../vs-code.service";

export class VitestAdapter implements TestFrameworkAdapter {
  private readonly vsCodeService = Container.get(VsCodeService);

  readonly name = "vitest" as const;
  private hooks: LifecycleHooks | null = null;
  private lastResults: TestResult[] = [];
  private lastDuration = 0;

  /**
   * Cached Vitest instance for session reuse.
   * Kept alive between runs so we skip re-initialization
   * (module graph, worker pool, Vite dev server, etc.).
   */
  private cachedVitest: any = null;
  /** The options fingerprint for the cached instance — invalidated on change. */
  private cachedFingerprint: string | null = null;

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
   * Run the specified test files using Vitest's Node API.
   *
   * Session Reuse: When running against the same project/config as the previous
   * run, the cached Vitest instance is reused and `rerunFiles()` is called.
   * This avoids re-creating the Vite dev server, module graph, and worker pool
   * — typically saving 2-5 seconds per run (similar to Wallaby's approach).
   *
   * A fresh instance is created when:
   *  - This is the first run
   *  - The project/config fingerprint changed (different project, config, or aliases)
   *  - The previous instance errored out
   */
  async executeTests(testFiles: string[], options: ExecutionOptions): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const runStart = Date.now();

    const normalizedRoot = this.normalizePath(options.projectRoot);
    const normalizedWorkspaceRoot = this.normalizePath(options.workspaceRoot);
    const normalizedConfig = options.configPath ? this.normalizePath(options.configPath) : undefined;

    // Convert input files to relative paths from project root
    const relFiles = testFiles.map((f) => {
      const abs = path.resolve(f);
      return path.relative(normalizedRoot, abs).replace(/\\/g, "/");
    });

    // Absolute normalized file paths — used as CLI filters when a config is present
    // so vitest can unambiguously match regardless of its resolved root.
    const absFiles = testFiles.map((f) => this.normalizePath(path.resolve(f)));

    // When a config file is provided, cwd should be the workspace root
    // (monorepo root) because that's where the user normally runs vitest from,
    // and plugins like vite-tsconfig-paths may rely on cwd for resolution.
    // Without a config, use the project root directly.
    const targetCwd = normalizedConfig ? normalizedWorkspaceRoot : normalizedRoot;

    const originalCwd = process.cwd();
    try {
      process.chdir(targetCwd);
    } catch (err) {
      this.vsCodeService.appendLine(`[VitestAdapter] Failed to chdir to ${targetCwd}: ` + err);
    }

    // Compute a fingerprint to decide whether we can reuse the cached instance
    const fingerprint = this.computeFingerprint(
      normalizedRoot,
      normalizedWorkspaceRoot,
      normalizedConfig,
      options.pathAliases,
    );
    const canReuse = this.cachedVitest && this.cachedFingerprint === fingerprint;

    this.vsCodeService.appendLine("[VitestAdapter] Starting test run for files: " + relFiles.join(", "));
    this.vsCodeService.appendLine(`[VitestAdapter] projectRoot: ${normalizedRoot}`);
    this.vsCodeService.appendLine(`[VitestAdapter] workspaceRoot: ${normalizedWorkspaceRoot}`);
    this.vsCodeService.appendLine(`[VitestAdapter] cwd: ${targetCwd}`);
    this.vsCodeService.appendLine(`[VitestAdapter] config: ${normalizedConfig ?? "none"}`);
    this.vsCodeService.appendLine(
      `[VitestAdapter] session reuse: ${canReuse ? "YES (rerunFiles)" : "NO (fresh instance)"}`,
    );

    try {
      let vitest: any;

      if (canReuse) {
        // ─── Reuse existing session ───────────────────────────
        vitest = this.cachedVitest;
        const rerunPaths = absFiles;
        this.vsCodeService.appendLine(
          `[VitestAdapter] Rerunning files on cached instance: ${JSON.stringify(rerunPaths)}`,
        );
        await vitest.rerunFiles(rerunPaths);
      } else {
        // ─── Create fresh instance ────────────────────────────
        // Close any stale cached instance first
        await this.closeCachedInstance();

        vitest = await this.createVitestInstance(
          options,
          normalizedRoot,
          normalizedWorkspaceRoot,
          normalizedConfig,
          relFiles,
          absFiles,
        );

        if (!vitest) {
          this.vsCodeService.appendLine("[VitestAdapter] startVitest returned null — tests may have failed to start");
          return results;
        }

        // Cache the instance for future reuse
        this.cachedVitest = vitest;
        this.cachedFingerprint = fingerprint;
      }

      // Extract results from TestModules using Vitest's state API
      const testModules = vitest.state.getTestModules();
      this.vsCodeService.appendLine(`[VitestAdapter] Test modules found: ${testModules.length}`);
      if (testModules.length === 0) {
        this.vsCodeService.appendLine("[VitestAdapter] No test modules — vitest may not have matched any files");
      }
      for (const testModule of testModules) {
        const moduleId: string = testModule.moduleId;

        // Fire file-level lifecycle hook
        this.hooks?.onFileStart?.(moduleId);

        // Iterate all test cases (deeply nested) through the children collection
        for (const testCase of testModule.children.allTests()) {
          const testResult = this.mapTestCaseToResult(testCase, moduleId);
          results.push(testResult);

          // Stream via lifecycle hook
          this.hooks?.onTestEnd?.(testResult);
        }

        this.hooks?.onFileEnd?.(moduleId);
      }
    } catch (err: any) {
      this.vsCodeService.appendLine("[VitestAdapter] Error running vitest: " + err);

      // Invalidate cached instance on error — it may be in a broken state
      await this.closeCachedInstance();

      // If vitest failed entirely, return a synthetic error result per file
      for (const file of testFiles) {
        const errorResult: TestResult = {
          testId: file,
          file,
          suite: [],
          name: path.basename(file),
          status: "failed",
          duration: 0,
          error: {
            message: err.message ?? String(err),
            stack: err.stack,
          },
        };
        results.push(errorResult);
        this.hooks?.onTestEnd?.(errorResult);
      }
    } finally {
      // Restore cwd — but do NOT close vitest (kept alive for session reuse)
      try {
        process.chdir(originalCwd);
      } catch {
        // Ignore chdir errors on cleanup
      }
    }

    this.lastResults = results;
    this.lastDuration = Date.now() - runStart;
    return results;
  }

  async collectResults(): Promise<CollectedResults> {
    return {
      results: this.lastResults,
      coverage: [],
      duration: this.lastDuration,
    };
  }

  async dispose(): Promise<void> {
    await this.closeCachedInstance();
    this.lastResults = [];
    this.lastDuration = 0;
    this.hooks = null;
  }

  // ─── Result mapping ───────────────────────────────────────

  /**
   * Map a Vitest TestCase to our TestResult interface.
   */
  private mapTestCaseToResult(testCase: any, moduleId: string): TestResult {
    const result = testCase.result();
    const diagnostic = testCase.diagnostic();
    const location = testCase.location;

    // Build the suite chain by walking parent nodes
    const suiteChain = this.buildSuiteChainFromParent(testCase);

    // Map vitest state → our TestStatus
    const status = this.mapState(result?.state);

    // Extract error information if present
    let error: TestResult["error"] = undefined;
    if (result?.errors && result.errors.length > 0) {
      const firstError = result.errors[0];
      error = {
        message: firstError.message ?? String(firstError),
        stack: firstError.stack,
        expected: firstError.expected,
        actual: firstError.actual,
        diff: firstError.diff,
      };
    }

    return {
      testId: testCase.id,
      file: moduleId,
      suite: suiteChain,
      name: testCase.name,
      status,
      duration: diagnostic?.duration ?? 0,
      error,
      line: location?.line,
    };
  }

  /**
   * Build a suite hierarchy chain by walking parent references.
   * TestCase.parent → TestSuite (or TestModule).
   * We stop at the module level (type === 'module').
   */
  private buildSuiteChainFromParent(testCase: any): string[] {
    const chain: string[] = [];
    let current = testCase.parent;
    while (current && current.type === "suite") {
      chain.unshift(current.name);
      current = current.parent;
    }
    return chain;
  }

  /**
   * Map Vitest's test result state to our TestStatus.
   */
  private mapState(state: string | undefined): TestStatus {
    switch (state) {
      case "passed":
        return "passed";
      case "failed":
        return "failed";
      case "skipped":
        return "skipped";
      default:
        return "skipped";
    }
  }

  // ─── Session Management ───────────────────────────────────

  /**
   * Create a fresh Vitest instance via startVitest().
   */
  private async createVitestInstance(
    options: ExecutionOptions,
    normalizedRoot: string,
    normalizedWorkspaceRoot: string,
    normalizedConfig: string | undefined,
    relFiles: string[],
    absFiles: string[],
  ): Promise<any> {
    // Resolve vitest/node from the USER'S workspace, not from the extension bundle.
    let vitestNode: any;
    try {
      const nativeWorkspaceRoot = path.resolve(options.workspaceRoot);
      const anchorUrl = pathToFileURL(path.join(nativeWorkspaceRoot, "__placeholder__.js")).href;
      this.vsCodeService.appendLine(`[VitestAdapter] Resolving vitest/node from: ${anchorUrl}`);
      const projectRequire = createRequire(anchorUrl);
      const vitestNodePath = projectRequire.resolve("vitest/node");
      this.vsCodeService.appendLine(`[VitestAdapter] Resolved vitest/node at: ${vitestNodePath}`);
      vitestNode = await import(pathToFileURL(vitestNodePath).href);
    } catch (resolveErr: any) {
      this.vsCodeService.appendLine(
        `[VitestAdapter] Failed to resolve vitest from workspace root: ${resolveErr.message}`,
      );
      vitestNode = await import("vitest/node");
    }
    const startVitest: typeof vitestNode.startVitest = vitestNode.startVitest;

    // Build Vitest CLI options
    const cliOptions: Record<string, any> = {
      // Use watch mode so the instance stays alive for rerunFiles()
      watch: true,
      reporters: ["default"],
      passWithNoTests: true,
      onConsoleLog: (log: string, type: "stdout" | "stderr", taskId?: string) => {
        const entry = this.parseConsoleLog(log, type, taskId);
        this.hooks?.onConsoleLog?.(entry);
        return false;
      },
    };

    if (!normalizedConfig) {
      cliOptions.include = relFiles;
    }

    if (normalizedConfig) {
      cliOptions.config = normalizedConfig;
    } else {
      cliOptions.config = false;
    }

    const viteOverrides: Record<string, any> = {};
    if (!normalizedConfig) {
      viteOverrides.root = normalizedRoot;
    }

    const resolvedAliases = this.buildViteAliases(options.pathAliases);
    if (Object.keys(resolvedAliases).length > 0) {
      viteOverrides.resolve = {
        ...viteOverrides.resolve,
        alias: resolvedAliases,
      };
      this.vsCodeService.appendLine(`[VitestAdapter] Injected ${Object.keys(resolvedAliases).length} path alias(es)}`);
    }

    const filterFiles = normalizedConfig ? absFiles : relFiles;

    this.vsCodeService.appendLine(
      `[VitestAdapter] Vitest CLI options: ${JSON.stringify(cliOptions)}, Vite overrides keys: ${JSON.stringify(Object.keys(viteOverrides))}`,
    );
    this.vsCodeService.appendLine(`[VitestAdapter] CLI filters (2nd arg): ${JSON.stringify(filterFiles)}`);

    const vitest = await startVitest("test", filterFiles, cliOptions, viteOverrides);
    return vitest;
  }

  /**
   * Close the cached Vitest instance if one exists.
   */
  private async closeCachedInstance(): Promise<void> {
    if (this.cachedVitest) {
      try {
        await this.cachedVitest.close();
      } catch {
        // Ignore close errors
      }
      this.cachedVitest = null;
      this.cachedFingerprint = null;
    }
  }

  /**
   * Compute a fingerprint for session reuse decisions.
   * Two runs with the same fingerprint can share the same Vitest instance.
   */
  private computeFingerprint(
    projectRoot: string,
    workspaceRoot: string,
    configPath: string | undefined,
    pathAliases: Record<string, string[]>,
  ): string {
    return JSON.stringify({projectRoot, workspaceRoot, configPath, pathAliases});
  }

  // ─── Helpers ──────────────────────────────────────────────

  /**
   * Convert resolved tsconfig path aliases into Vite `resolve.alias` entries.
   *
   * tsconfig paths format (resolved to absolute paths):
   *   { "@shared/*": ["C:/abs/libs/shared/src/*"], "@core": ["C:/abs/libs/core/src/index.ts"] }
   *
   * Vite alias format (what we produce):
   *   { "@shared": "C:/abs/libs/shared/src", "@core": "C:/abs/libs/core/src/index.ts" }
   *
   * For wildcard aliases (`@shared/*`), we strip the trailing `/*` from both
   * the key and the first mapped path so Vite can do prefix matching.
   * Non-wildcard aliases are passed through as-is.
   * Paths are normalized to forward slashes for Vite compatibility.
   */
  private buildViteAliases(pathAliases: Record<string, string[]>): Record<string, string> {
    const aliases: Record<string, string> = {};

    for (const [pattern, targets] of Object.entries(pathAliases)) {
      if (!targets || targets.length === 0) {
        continue;
      }

      // Normalize to forward slashes for Vite
      const firstTarget = targets[0].replace(/\\/g, "/");

      if (pattern.endsWith("/*")) {
        // Wildcard alias: "@shared/*" → "@shared"
        const aliasKey = pattern.slice(0, -2);
        // Strip trailing /* or * from the resolved path
        const aliasValue = firstTarget.replace(/\/?\*$/, "");
        aliases[aliasKey] = aliasValue;
      } else {
        // Exact alias — use as-is
        aliases[pattern] = firstTarget;
      }
    }

    return aliases;
  }

  /**
   * Parse a raw console log string from Vitest into a ConsoleLogEntry.
   *
   * @param log     The raw log content
   * @param stream  "stdout" or "stderr"
   * @param taskId  Optional vitest task ID — this is typically the module/file path
   */
  private parseConsoleLog(log: string, stream: "stdout" | "stderr", taskId?: string): ConsoleLogEntry {
    let file: string | undefined;
    let line: number | undefined;
    let content = log;

    // The taskId from Vitest is usually the absolute file path of the test module
    if (taskId) {
      file = taskId;
    }

    // Try to extract file info from vitest's console log format
    // Vitest logs look like: "stdout | src/file.ts > suite > test"
    const headerMatch = log.match(/^(stdout|stderr)\s+\|\s+(.+?)(?:\s*>\s*.+)?\n([\s\S]*)$/);
    if (headerMatch) {
      if (!file) {
        file = headerMatch[2].trim();
      }
      content = headerMatch[3] || log;
    }

    // Also try to find source location from a stack-like pattern in content
    // e.g. "at Object.<anonymous> (src/file.ts:42:15)"
    if (!line) {
      const stackMatch = content.match(/(?:at\s+.*?\(|❯\s*|at\s+)([A-Za-z]:[\\/].*?|\/.*?):(\d+)/);
      if (stackMatch) {
        if (!file) {
          file = stackMatch[1];
        }
        line = parseInt(stackMatch[2], 10);
      }
    }

    return {
      stream,
      content: content.trimEnd(),
      file,
      line,
      timestamp: Date.now(),
    };
  }

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
}
