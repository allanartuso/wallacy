import type {
  TestInfo,
  TestResult,
  ExecutionOptions,
  LifecycleHooks,
  CollectedResults,
  TestFrameworkName,
} from "../shared-types";

/**
 * Common interface for all test framework adapters (Jest, Vitest, Jasmine).
 *
 * WHY: This abstraction allows the core engine to be framework-agnostic.
 * The engine only cares about "run these tests with these options",
 * while the adapter handles the framework-specific plumbing.
 */
export interface TestFrameworkAdapter {
  readonly name: TestFrameworkName;

  /**
   * Discover all tests in a project by scanning the filesystem or
   * using the framework's internal discovery API.
   */
  discoverTests(
    projectRoot: string,
    configPath: string | null,
  ): Promise<TestInfo[]>;

  /**
   * Execute a specific set of tests.
   * @param testIds List of test IDs to run
   * @param options Execution context (coverage, tracing, etc.)
   */
  executeTests(
    testIds: string[],
    options: ExecutionOptions,
  ): Promise<TestResult[]>;

  /**
   * Hook into the framework's lifecycle events (e.g., test start/end, suite start/end).
   * Used for runtime tracing and streaming results.
   */
  hookIntoLifecycle(hooks: LifecycleHooks): void;

  /**
   * Collect the final set of results and coverage data after a run.
   */
  collectResults(): Promise<CollectedResults>;

  /**
   * Clean up any long-lived resources (workers, watchers, etc.).
   */
  dispose(): Promise<void>;
}
