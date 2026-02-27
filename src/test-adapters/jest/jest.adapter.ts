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

/**
 * JestAdapter — Full implementation using Jest's programmatic API.
 *
 * Strategy:
 *  1. Resolve `@jest/core` from the USER's workspace `node_modules`.
 *  2. Call `runCLI()` programmatically with appropriate options.
 *  3. Map Jest's `AggregatedResult` to our `TestResult[]` interface.
 *  4. Cache the resolved jest module path across runs for speed.
 *
 * Jest doesn't have a persistent watch-mode API like Vitest's `rerunFiles()`,
 * so each run calls `runCLI()` afresh. However, Jest's own internal haste map
 * and transform cache (in node_modules/.cache/jest) make subsequent runs
 * significantly faster than a cold start.
 */
export class JestAdapter implements TestFrameworkAdapter {
  private readonly vsCodeService = Container.get(VsCodeService);

  readonly name = "jest" as const;
  private hooks: LifecycleHooks | null = null;
  private lastResults: TestResult[] = [];
  private lastDuration = 0;

  /** Cached path to the resolved jest module for faster subsequent runs. */
  private cachedJestModulePath: string | null = null;

  /**
   * Discover tests in a project by scanning the filesystem.
   */
  async discoverTests(projectRoot: string, _configPath: string | null): Promise<TestInfo[]> {
    const testFiles = this.globTestFiles(projectRoot);
    return testFiles.map((file) => ({
      id: file,
      file,
      suite: [],
      name: path.basename(file),
    }));
  }

  hookIntoLifecycle(hooks: LifecycleHooks): void {
    this.hooks = hooks;
  }

  /**
   * Run the specified test files using Jest's programmatic API (`runCLI`).
   *
   * Jest doesn't have a persistent instance API like Vitest's `rerunFiles()`,
   * but its internal haste map and transform cache make subsequent runs
   * significantly faster than a cold start.
   */
  async executeTests(testFiles: string[], options: ExecutionOptions): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const runStart = Date.now();

    const normalizedRoot = this.normalizePath(options.projectRoot);
    const normalizedWorkspaceRoot = this.normalizePath(options.workspaceRoot);
    const normalizedConfig = options.configPath ? this.normalizePath(options.configPath) : undefined;

    // Absolute normalized file paths for Jest
    const absFiles = testFiles.map((f) => this.normalizePath(path.resolve(f)));

    const originalCwd = process.cwd();
    try {
      process.chdir(normalizedRoot);
    } catch (err) {
      this.vsCodeService.appendLine(`[JestAdapter] Failed to chdir to ${normalizedRoot}: ` + err);
    }

    this.vsCodeService.appendLine("[JestAdapter] Starting test run for files: " + absFiles.join(", "));
    this.vsCodeService.appendLine(`[JestAdapter] projectRoot: ${normalizedRoot}`);
    this.vsCodeService.appendLine(`[JestAdapter] workspaceRoot: ${normalizedWorkspaceRoot}`);
    this.vsCodeService.appendLine(`[JestAdapter] config: ${normalizedConfig ?? "none"}`);

    try {
      // Resolve jest from the USER'S workspace
      const runCLI = await this.resolveJestRunCLI(options.workspaceRoot);

      // Build Jest CLI argv
      const jestArgv: Record<string, any> = {
        // Run in non-interactive, CI-like mode
        ci: true,
        // Don't watch — single run
        watchAll: false,
        watch: false,
        // Verbose to get individual test results
        verbose: true,
        // No coverage by default
        coverage: false,
        // Disable colors in output
        colors: false,
        // Use the config if provided
        ...(normalizedConfig ? {config: normalizedConfig} : {}),
        // Pass test file patterns — escape for regex safety
        testPathPattern: absFiles.map((f) => this.escapeRegex(f)).join("|"),
      };

      // Inject tsconfig path aliases as moduleNameMapper
      const mapperOverrides = this.buildModuleNameMapper(options.pathAliases);
      if (mapperOverrides.moduleNameMapper) {
        jestArgv.moduleNameMapper = JSON.stringify(mapperOverrides.moduleNameMapper);
      }

      this.vsCodeService.appendLine(`[JestAdapter] Jest argv: ${JSON.stringify(jestArgv)}`);

      // Run Jest
      const {results: jestResults} = await runCLI(jestArgv, [normalizedRoot]);

      // Map Jest results to our TestResult format
      this.mapJestResults(jestResults, results);
    } catch (err: any) {
      this.vsCodeService.appendLine("[JestAdapter] Error running jest: " + err);
      // Return synthetic error results
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
    this.lastResults = [];
    this.lastDuration = 0;
    this.hooks = null;
    this.cachedJestModulePath = null;
  }

  // ─── Jest Resolution ──────────────────────────────────────

  /**
   * Resolve jest's `runCLI` function from the user's workspace.
   * Caches the resolved module path for faster subsequent lookups.
   */
  private async resolveJestRunCLI(workspaceRoot: string): Promise<any> {
    if (this.cachedJestModulePath) {
      this.vsCodeService.appendLine(`[JestAdapter] Using cached jest module: ${this.cachedJestModulePath}`);
      const jestModule = await import(pathToFileURL(this.cachedJestModulePath).href);
      return jestModule.runCLI || jestModule.default?.runCLI;
    }

    const nativeWorkspaceRoot = path.resolve(workspaceRoot);
    const anchorUrl = pathToFileURL(path.join(nativeWorkspaceRoot, "__placeholder__.js")).href;
    this.vsCodeService.appendLine(`[JestAdapter] Resolving jest from: ${anchorUrl}`);

    const projectRequire = createRequire(anchorUrl);

    // Try multiple resolution paths — jest ships runCLI in different packages
    // depending on version:
    //   jest >= 27: @jest/core exports runCLI
    //   jest < 27:  jest-cli exports runCLI
    const candidates = ["@jest/core", "jest-cli", "jest"];

    for (const candidate of candidates) {
      try {
        const resolvedPath = projectRequire.resolve(candidate);
        this.vsCodeService.appendLine(`[JestAdapter] Resolved ${candidate} at: ${resolvedPath}`);
        const jestModule = await import(pathToFileURL(resolvedPath).href);
        const runCLI = jestModule.runCLI || jestModule.default?.runCLI;
        if (typeof runCLI === "function") {
          this.cachedJestModulePath = resolvedPath;
          this.vsCodeService.appendLine(`[JestAdapter] Using runCLI from: ${candidate}`);
          return runCLI;
        }
        this.vsCodeService.appendLine(`[JestAdapter] ${candidate} resolved but no runCLI found`);
      } catch (err: any) {
        this.vsCodeService.appendLine(`[JestAdapter] Cannot resolve ${candidate}: ${err.message}`);
      }
    }

    throw new Error("Could not resolve Jest from workspace. Ensure jest is installed in your project's node_modules.");
  }

  // ─── Result Mapping ───────────────────────────────────────

  /**
   * Map Jest's AggregatedResult to our TestResult[] format.
   *
   * Jest structure:
   *   AggregatedResult.testResults[] → per-file test suite result
   *     .testResults[].testResults[] → per-test assertion result
   */
  private mapJestResults(jestResults: any, results: TestResult[]): void {
    if (!jestResults || !jestResults.testResults) {
      this.vsCodeService.appendLine("[JestAdapter] No test results from Jest");
      return;
    }

    const testSuites = jestResults.testResults;
    this.vsCodeService.appendLine(`[JestAdapter] Test suites found: ${testSuites.length}`);

    for (const suite of testSuites) {
      const moduleFile: string = suite.testFilePath || suite.name || "unknown";

      this.hooks?.onFileStart?.(moduleFile);

      // Process console output from this test file
      if (suite.console && Array.isArray(suite.console)) {
        for (const logEntry of suite.console) {
          const entry: ConsoleLogEntry = {
            stream: logEntry.type === "error" || logEntry.type === "warn" ? "stderr" : "stdout",
            content: logEntry.message,
            file: moduleFile,
            line: logEntry.origin ? this.extractLineFromOrigin(logEntry.origin) : undefined,
            timestamp: Date.now(),
          };
          this.hooks?.onConsoleLog?.(entry);
        }
      }

      // Map each assertion result (individual it/test)
      if (suite.testResults && Array.isArray(suite.testResults)) {
        for (const assertion of suite.testResults) {
          const testResult = this.mapAssertionToResult(assertion, moduleFile);
          results.push(testResult);
          this.hooks?.onTestEnd?.(testResult);
        }
      }

      this.hooks?.onFileEnd?.(moduleFile);
    }
  }

  /**
   * Map a Jest AssertionResult to our TestResult.
   */
  private mapAssertionToResult(assertion: any, moduleFile: string): TestResult {
    const status = this.mapJestStatus(assertion.status);
    const suite: string[] = assertion.ancestorTitles || [];

    let error: TestResult["error"] = undefined;
    if (assertion.failureMessages && assertion.failureMessages.length > 0) {
      const firstFailure = assertion.failureMessages[0];
      error = this.parseJestFailure(firstFailure);
    }

    return {
      testId: `${moduleFile}::${suite.join(" > ")}::${assertion.title || assertion.fullName}`,
      file: moduleFile,
      suite,
      name: assertion.title || assertion.fullName || "unknown",
      status,
      duration: assertion.duration ?? 0,
      error,
      line: assertion.location?.line,
    };
  }

  /**
   * Map Jest's test status to our TestStatus.
   */
  private mapJestStatus(status: string): TestStatus {
    switch (status) {
      case "passed":
        return "passed";
      case "failed":
        return "failed";
      case "pending":
      case "skipped":
      case "todo":
      case "disabled":
        return "skipped";
      default:
        return "skipped";
    }
  }

  /**
   * Parse a Jest failure message into our error format.
   *
   * Jest failure messages typically look like:
   *   "Error: expect(received).toBe(expected)\n\nExpected: 4\nReceived: 5\n\n    at Object...."
   */
  private parseJestFailure(failureMessage: string): TestResult["error"] {
    const lines = failureMessage.split("\n");

    // Find where the stack trace starts
    let stackStartIndex = lines.findIndex((l) => /^\s+at\s/.test(l));
    if (stackStartIndex === -1) {
      stackStartIndex = lines.length;
    }

    const messageLines = lines.slice(0, stackStartIndex);
    const stackLines = lines.slice(stackStartIndex);

    const message = messageLines.join("\n").trim();
    const stack = stackLines.length > 0 ? stackLines.join("\n") : undefined;

    // Extract expected/actual from Jest's output
    let expected: unknown;
    let actual: unknown;
    let diff: string | undefined;

    const expectedMatch = message.match(/Expected:\s*(.*)/);
    const receivedMatch = message.match(/Received:\s*(.*)/);

    if (expectedMatch) {
      expected = expectedMatch[1].trim();
    }
    if (receivedMatch) {
      actual = receivedMatch[1].trim();
    }

    // Look for a diff block
    const diffMatch = failureMessage.match(/(-\s+Expected[\s\S]*?\+\s+Received[\s\S]*?)(?=\n\s+at\s|\n*$)/);
    if (diffMatch) {
      diff = diffMatch[1];
    }

    return {
      message,
      stack,
      expected,
      actual,
      diff,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────

  /**
   * Build moduleNameMapper from tsconfig path aliases for Jest.
   *
   * tsconfig paths: { "@shared/*": ["libs/shared/src/*"] }
   * Jest mapper:    { "^@shared/(.*)$": "libs/shared/src/$1" }
   */
  private buildModuleNameMapper(pathAliases: Record<string, string[]>): Record<string, any> {
    const mapper: Record<string, string> = {};
    let hasEntries = false;

    for (const [pattern, targets] of Object.entries(pathAliases)) {
      if (!targets || targets.length === 0) {
        continue;
      }

      const firstTarget = targets[0].replace(/\\/g, "/");

      if (pattern.endsWith("/*")) {
        const aliasKey = pattern.slice(0, -2);
        const aliasValue = firstTarget.replace(/\/?\*$/, "");
        mapper[`^${this.escapeRegex(aliasKey)}/(.*)$`] = `${aliasValue}/$1`;
        hasEntries = true;
      } else {
        mapper[`^${this.escapeRegex(pattern)}$`] = firstTarget;
        hasEntries = true;
      }
    }

    return hasEntries ? {moduleNameMapper: mapper} : {};
  }

  /**
   * Extract a line number from Jest's console log origin string.
   * Origin format: "at Object.<anonymous> (/path/to/file.ts:42:15)"
   */
  private extractLineFromOrigin(origin: string): number | undefined {
    const match = origin.match(/:(\d+)(?::\d+)?\)?$/);
    return match ? parseInt(match[1], 10) : undefined;
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private normalizePath(p: string): string {
    const absolute = path.resolve(p);
    let normalized = absolute;
    if (process.platform === "win32" && absolute.length > 1 && absolute[1] === ":") {
      normalized = absolute[0].toUpperCase() + absolute.substring(1);
    }
    return normalized.replace(/\\/g, "/");
  }

  // ─── File Discovery ───────────────────────────────────────

  private globTestFiles(projectRoot: string): string[] {
    const found: string[] = [];
    this.walkDir(projectRoot, found, 0);
    return found;
  }

  private walkDir(dir: string, results: string[], depth: number): void {
    if (depth > 6) {
      return;
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
        if (["node_modules", "dist", ".git", "coverage", ".nx"].includes(entry.name)) {
          continue;
        }
        this.walkDir(fullPath, results, depth + 1);
      } else if (entry.isFile()) {
        if (/\.(test|spec)\.(ts|js|tsx|jsx|mts|mjs)$/.test(entry.name)) {
          results.push(fullPath);
        }
      }
    }
  }
}
