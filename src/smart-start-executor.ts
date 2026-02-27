/**
 * SmartStartExecutor — Testable core logic for the Smart Start command.
 *
 * Encapsulates the full pipeline:
 *   1. Resolve project, framework, config, and tsconfig for a file
 *   2. Create the correct test adapter
 *   3. Discover tests
 *   4. Execute tests and stream results
 *
 * This class has NO dependency on VS Code APIs so it can be
 * integration-tested without the extension host.
 */

import * as path from "node:path";
import Container, {Service} from "typedi";
import {NxWorkspaceResolver} from "./core-engine/nx-resolver/workspace-resolver";
import {SmartStartResolver} from "./core-engine/smart-start/smart-start-resolver";
import type {
  CollectedResults,
  ConsoleLogEntry,
  ExecutionOptions,
  LifecycleHooks,
  SmartStartResult,
  TestFrameworkAdapter,
  TestInfo,
  TestResult,
} from "./shared-types";
import {JasmineAdapter, JestAdapter, VitestAdapter} from "./test-adapters";
import {VsCodeService} from "./vs-code.service";

// ─── Types ──────────────────────────────────────────────────

export interface SmartStartCallbacks {
  onResolved?: (result: SmartStartResult) => void;
  onTestsDiscovered?: (tests: TestInfo[]) => void;
  onTestResult?: (result: TestResult) => void;
  onRunComplete?: (results: CollectedResults) => void;
  onConsoleLog?: (entry: ConsoleLogEntry) => void;
  onError?: (error: Error) => void;
  onLog?: (message: string) => void;
}

export interface SmartStartExecuteResult {
  resolution: SmartStartResult;
  tests: TestInfo[];
  results: TestResult[];
  collected: CollectedResults;
}

// ─── SmartStartExecutor ─────────────────────────────────────

@Service()
export class SmartStartExecutor {
  private readonly smartStartResolver: SmartStartResolver = Container.get(SmartStartResolver);
  private readonly nxWorkspaceResolver = Container.get(NxWorkspaceResolver);
  private readonly vsCodeService = Container.get(VsCodeService);

  /**
   * Full Smart Start pipeline for a given test file.
   *
   * @param filePath Absolute path to the focused test file
   * @param callbacks Optional callbacks for streaming progress
   * @returns The complete result of the pipeline
   */
  async execute(filePath: string, callbacks?: SmartStartCallbacks): Promise<SmartStartExecuteResult> {
    const root = this.nxWorkspaceResolver.getWorkspaceRoot();
    this.vsCodeService.appendLine(
      `[SmartStartExecutor] Starting Smart Start for: ${root} => ${path.basename(filePath)}`,
    );

    // Step 1: Resolve everything
    let resolution: SmartStartResult;
    try {
      resolution = await this.smartStartResolver.resolve(filePath);
    } catch (error: any) {
      callbacks?.onError?.(error);
      throw error;
    }

    this.vsCodeService.appendLine(
      `[SmartStartExecutor] Resolved: ${resolution.project.name} ` +
        `(${resolution.testFramework}), config: ${resolution.configPath ?? "none"}`,
    );
    callbacks?.onResolved?.(resolution);

    // Step 2: Create the adapter
    const adapter = this.createAdapter(resolution.testFramework);

    // Step 3: Resolve the absolute project root
    const absoluteProjectRoot = path.isAbsolute(resolution.project.root)
      ? resolution.project.root
      : path.join(this.nxWorkspaceResolver.getWorkspaceRoot(), resolution.project.root);

    // Step 4: Discover tests
    this.vsCodeService.appendLine(`[SmartStartExecutor] Discovering tests in: ${absoluteProjectRoot}`);
    const tests = await adapter.discoverTests(absoluteProjectRoot, resolution.configPath);
    this.vsCodeService.appendLine(`[SmartStartExecutor] Discovered ${tests.length} test(s)`);
    callbacks?.onTestsDiscovered?.(tests);

    // Step 5: Set up lifecycle hooks for streaming
    const allResults: TestResult[] = [];
    const hooks: LifecycleHooks = {
      onTestEnd: (result) => {
        allResults.push(result);
        callbacks?.onTestResult?.(result);
      },
      onConsoleLog: (entry) => {
        callbacks?.onConsoleLog?.(entry);
      },
    };
    adapter.hookIntoLifecycle(hooks);

    // Step 6: Execute tests
    const options: ExecutionOptions = {
      projectRoot: absoluteProjectRoot,
      workspaceRoot: this.nxWorkspaceResolver.getWorkspaceRoot(),
      configPath: resolution.configPath,
      tsconfigPath: resolution.tsconfigPath,
      pathAliases: resolution.pathAliases,
      instrumentation: {
        lineCoverage: false,
        branchCoverage: false,
        valueCapture: false,
        importTracing: false,
        functionTracing: false,
      },
      timeout: 30_000,
    };

    this.vsCodeService.appendLine(`[SmartStartExecutor] Running tests...`);
    const executeResults = await adapter.executeTests([filePath], options);

    // Merge results from executeTests that weren't streamed via hooks
    for (const r of executeResults) {
      if (!allResults.some((ar) => ar.testId === r.testId)) {
        allResults.push(r);
        callbacks?.onTestResult?.(r);
      }
    }

    // Step 7: Collect final results
    const collected = await adapter.collectResults();
    this.vsCodeService.appendLine(`[SmartStartExecutor] Run complete — ${allResults.length} result(s)`);
    callbacks?.onRunComplete?.(collected);

    // Cleanup
    await adapter.dispose();

    return {
      resolution,
      tests,
      results: allResults,
      collected,
    };
  }

  /**
   * Resolve-only: get the SmartStartResult without running tests.
   * Useful for quick framework/config detection.
   */
  async resolve(filePath: string): Promise<SmartStartResult> {
    return this.smartStartResolver.resolve(filePath);
  }

  // ─── Private ──────────────────────────────────────────────

  private createAdapter(framework: string): TestFrameworkAdapter {
    switch (framework) {
      case "vitest":
        return new VitestAdapter();
      case "jest":
        return new JestAdapter();
      case "jasmine":
        return new JasmineAdapter();
      default:
        throw new Error(`Unsupported test framework: ${framework}`);
    }
  }
}
