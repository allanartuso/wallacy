// ============================================================
// @test-runner/shared-types — All cross-package TypeScript types
// ============================================================

// ─── Nx Project Resolution ──────────────────────────────────

export interface TargetConfiguration {
  executor?: string;
  options?: Record<string, unknown>;
  configurations?: Record<string, Record<string, unknown>>;
}

export interface NxProjectInfo {
  /** Unique project name in the Nx workspace */
  name: string;
  /** Relative path from workspace root to project root */
  root: string;
  /** Relative path from workspace root to source root */
  sourceRoot: string;
  /** Nx targets defined for this project */
  targets: Record<string, TargetConfiguration>;
  /** Tags applied to the project */
  tags: string[];
  /** Explicit implicit dependencies */
  implicitDependencies: string[];
  /** Project type: application or library */
  projectType?: "application" | "library";
}

// ─── Smart Start ────────────────────────────────────────────

export type TestFrameworkName = "jasmine" | "jest" | "vitest";

export interface SmartStartResult {
  /** The resolved Nx project */
  project: NxProjectInfo;
  /** Detected test framework */
  testFramework: TestFrameworkName;
  /** Name of the Nx target that runs tests */
  testTarget: string;
  /** Absolute path to the framework config file (jest.config.ts, etc.) */
  configPath: string | null;
  /** Absolute path to the closest tsconfig.json for the focused file */
  tsconfigPath: string | null;
  /** Resolved TypeScript path aliases from tsconfig compilerOptions.paths */
  pathAliases: Record<string, string[]>;
  /** Names of Nx projects that depend on this project (transitively) */
  dependents: string[];
}

export interface SmartStartRequest {
  /** Absolute path to the file the user has focused */
  filePath: string;
  /** Whether to include dependent project tests */
  includeDependents?: boolean;
}

// ─── Virtual File System ────────────────────────────────────

export interface FileSnapshot {
  /** Absolute path */
  path: string;
  /** File content */
  content: string;
  /** Monotonically increasing version number */
  version: number;
  /** Content-addressable hash for cache invalidation */
  hash: string;
  /** Where this snapshot came from */
  source: "disk" | "buffer";
  /** Timestamp of last modification */
  timestamp: number;
}

export interface FileDiff {
  path: string;
  type: "added" | "removed" | "changed";
  oldHash?: string;
  newHash?: string;
}

// ─── Instrumentation ───────────────────────────────────────

export interface InstrumentationOptions {
  /** Enable line coverage probes */
  lineCoverage: boolean;
  /** Enable branch coverage probes */
  branchCoverage: boolean;
  /** Enable runtime value capture */
  valueCapture: boolean;
  /** Enable import tracing */
  importTracing: boolean;
  /** Enable function entry/exit tracing */
  functionTracing: boolean;
}

export interface InstrumentedFile {
  /** Original absolute path */
  originalPath: string;
  /** Instrumented source code */
  code: string;
  /** Source map (JSON) mapping instrumented → original */
  sourceMap: string;
  /** Content hash of the original file (for cache key) */
  originalHash: string;
}

// ─── Runtime Dependency Graph ──────────────────────────────

export interface DependencyEdge {
  /** The source/library file that was executed */
  sourceFile: string;
  /** The test file that caused it to execute */
  testFile: string;
  /** How we know about this edge */
  confidence: "runtime" | "static";
  /** Timestamp when this edge was last confirmed */
  lastSeen: number;
}

// ─── Test Framework Adapter ─────────────────────────────────

export interface TestInfo {
  /** Unique test identifier (file + suite path + test name) */
  id: string;
  /** Absolute path to the test file */
  file: string;
  /** Suite hierarchy, e.g. ["describe A", "describe B"] */
  suite: string[];
  /** Test name */
  name: string;
  /** Line number in the original file */
  line?: number;
}

export interface TestError {
  message: string;
  stack?: string;
  expected?: unknown;
  actual?: unknown;
  diff?: string;
}

export type TestStatus = "passed" | "failed" | "skipped" | "running";

export interface TestResult {
  /** Same ID as TestInfo.id */
  testId: string;
  file: string;
  suite: string[];
  name: string;
  status: TestStatus;
  duration: number;
  error?: TestError;
  /** Line number where the test is defined */
  line?: number;
  coverage?: FileCoverage[];
}

export interface FileCoverage {
  /** Absolute path to the covered file */
  path: string;
  /** Line numbers that were executed */
  executedLines: number[];
  /** Total line count */
  totalLines: number;
  /** Branch coverage data */
  branches?: BranchCoverage[];
}

export interface BranchCoverage {
  line: number;
  branchIndex: number;
  taken: boolean;
}

export interface ExecutionOptions {
  /** Absolute path to project root */
  projectRoot: string;
  /** Absolute path to the workspace / monorepo root (where node_modules lives) */
  workspaceRoot: string;
  /** Path to framework config */
  configPath: string | null;
  /** Absolute path to the closest tsconfig.json (for path alias resolution) */
  tsconfigPath: string | null;
  /** Resolved TypeScript path aliases — keys are alias patterns, values are absolute paths */
  pathAliases: Record<string, string[]>;
  /** Instrumentation options */
  instrumentation: InstrumentationOptions;
  /** Timeout per test in ms */
  timeout?: number;
}

export interface CollectedResults {
  results: TestResult[];
  coverage: FileCoverage[];
  duration: number;
}

// ─── Console Output ────────────────────────────────────────

export interface ConsoleLogEntry {
  /** Source of the log — 'stdout' or 'stderr' */
  stream: "stdout" | "stderr";
  /** The log content */
  content: string;
  /** File that produced the log (if known) */
  file?: string;
  /** Line number (if known) */
  line?: number;
  /** Timestamp */
  timestamp: number;
}

export interface LifecycleHooks {
  onTestStart?: (testId: string) => void;
  onTestEnd?: (result: TestResult) => void;
  onSuiteStart?: (suiteName: string) => void;
  onSuiteEnd?: (suiteName: string) => void;
  onFileStart?: (filePath: string) => void;
  onFileEnd?: (filePath: string) => void;
  onConsoleLog?: (entry: ConsoleLogEntry) => void;
}

export interface TestFrameworkAdapter {
  readonly name: TestFrameworkName;

  /** Discover all tests in the project */
  discoverTests(projectRoot: string, configPath: string | null): Promise<TestInfo[]>;

  /** Execute specific tests by ID */
  executeTests(testIds: string[], options: ExecutionOptions): Promise<TestResult[]>;

  /** Hook into framework lifecycle for runtime tracing */
  hookIntoLifecycle(hooks: LifecycleHooks): void;

  /** Collect coverage + results after execution */
  collectResults(): Promise<CollectedResults>;

  /** Dispose resources */
  dispose(): Promise<void>;
}

// ─── IPC Protocol ──────────────────────────────────────────

export interface IPCEnvelope<T = unknown> {
  /** Unique message ID for idempotency */
  id: string;
  /** Sequence number for ordering */
  seq: number;
  /** Message type discriminator */
  type: string;
  /** Type-specific payload */
  payload: T;
  /** Unix timestamp */
  timestamp: number;
}

export type EngineStatus = "idle" | "starting" | "running" | "stopping" | "error";

export type IPCMessageType =
  | "smart-start-request"
  | "smart-start-response"
  | "run-all-tests"
  | "test-discovery"
  | "test-result"
  | "test-run-start"
  | "test-run-update"
  | "test-run-request"
  | "test-run-complete"
  | "coverage-delta"
  | "engine-status"
  | "file-changed"
  | "buffer-update"
  | "execution-trace"
  | "error"
  | "diagnostics";

// ─── Execution Tracing ────────────────────────────────────

export type TraceEventType = "function-enter" | "function-exit" | "assignment" | "branch";

export interface TraceEvent {
  type: TraceEventType;
  /** File where the event occurred */
  file: string;
  /** Line number */
  line: number;
  /** Column number */
  column: number;
  /** Function or variable name */
  name: string;
  /** Captured value (serialized) */
  value?: string;
  /** High-resolution timestamp */
  timestamp: number;
}

export interface ExecutionSnapshot {
  /** Unique snapshot ID */
  id: string;
  /** Parent snapshot (for time-travel chain) */
  parentId: string | null;
  /** Test that produced this snapshot */
  testId: string;
  /** Trace events in this snapshot */
  events: TraceEvent[];
  /** Timestamp */
  timestamp: number;
}

// ─── Configuration ─────────────────────────────────────────

export interface ContinuousTestConfig {
  /** Override framework per project name */
  frameworks?: Record<string, TestFrameworkName>;
  /** Maximum number of parallel test workers */
  maxWorkers?: number;
  /** Coverage options */
  coverage?: {
    enabled: boolean;
    lines: boolean;
    branches: boolean;
  };
  /** Debug options */
  debug?: {
    tracing: boolean;
    verbose: boolean;
  };
  /** Per-project overrides */
  projects?: Record<string, Partial<ContinuousTestConfig>>;
}
