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
 * JestAdapter — Skeleton implementation for Jest.
 *
 * WHY: To be fully implemented using Jest's programmatic API
 * (jest-runner, jest-haste-map).
 */
export class JestAdapter implements TestFrameworkAdapter {
  readonly name: TestFrameworkName = "jest";

  async discoverTests(
    projectRoot: string,
    configPath: string | null,
  ): Promise<TestInfo[]> {
    // TODO: Use jest-haste-map or scan filesystem
    return [];
  }

  async executeTests(
    testIds: string[],
    options: ExecutionOptions,
  ): Promise<TestResult[]> {
    // TODO: Use jest-runner
    return [];
  }

  hookIntoLifecycle(hooks: LifecycleHooks): void {
    // TODO: Implement custom reporter/environment
  }

  async collectResults(): Promise<CollectedResults> {
    return {
      results: [],
      coverage: [],
      duration: 0,
    };
  }

  async dispose(): Promise<void> {
    // Cleanup Haste map etc.
  }
}
