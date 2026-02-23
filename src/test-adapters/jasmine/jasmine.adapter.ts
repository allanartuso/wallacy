import type {
  TestInfo,
  TestResult,
  ExecutionOptions,
  LifecycleHooks,
  CollectedResults,
  TestFrameworkName,
  TestFrameworkAdapter,
} from "../../shared-types";

/**
 * JasmineAdapter — Skeleton implementation for Jasmine.
 *
 * WHY: To be fully implemented using Jasmine's programmatic API.
 */
export class JasmineAdapter implements TestFrameworkAdapter {
  readonly name: TestFrameworkName = "jasmine";

  async discoverTests(
    projectRoot: string,
    configPath: string | null,
  ): Promise<TestInfo[]> {
    return [];
  }

  async executeTests(
    testIds: string[],
    options: ExecutionOptions,
  ): Promise<TestResult[]> {
    return [];
  }

  hookIntoLifecycle(hooks: LifecycleHooks): void {
    // TODO: Implement custom reporter
  }

  async collectResults(): Promise<CollectedResults> {
    return {
      results: [],
      coverage: [],
      duration: 0,
    };
  }

  async dispose(): Promise<void> {}
}
