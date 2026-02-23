// ============================================================
// TestExecutor — Coordinates the actual execution of tests.
//
// WHY: It takes a TestRunRequest, identifies the correct
// adapter for each project, and streams results back to the
// IPC server in real-time.
// ============================================================

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { TestRunRequest } from "./execution-queue";
import type { IPCServer } from "../ipc/server";
import type { FileToProjectMapper } from "../nx-resolver/file-mapper";
import {
  TestFrameworkAdapter,
  ExecutionOptions,
  NxProjectInfo,
} from "../../shared-types";
import {
  AdapterAutoDetector,
  VitestAdapter,
  JestAdapter,
  JasmineAdapter,
} from "../../test-adapters";

export class TestExecutor {
  private adapters = new Map<string, TestFrameworkAdapter>();

  constructor(
    private readonly server: IPCServer,
    private readonly projectMapper: FileToProjectMapper,
    private readonly workspaceRoot: string,
  ) {}

  /**
   * Execute tests specified in a request.
   */
  async execute(request: TestRunRequest, signal?: AbortSignal): Promise<void> {
    this.server.broadcast("engine-status", "running");
    this.server.broadcast("test-run-start", {
      testFiles: Array.from(request.testFiles),
      timestamp: request.timestamp,
    });

    try {
      // Group test files by project
      let projectGroups: Map<string, Set<string>>;

      if (request.testFiles.size === 0 && request.projectNames.size > 0) {
        // Run all tests for specified projects
        projectGroups = new Map();
        for (const name of request.projectNames) {
          projectGroups.set(name, new Set()); // Empty set means run all
        }
      } else {
        projectGroups = await this.groupTestsByProject(request.testFiles);
      }

      for (const [projectName, testFiles] of projectGroups.entries()) {
        if (signal?.aborted) throw new Error("Aborted");

        const project =
          await this.projectMapper.workspaceResolver.getProjectByName(
            projectName,
          );
        if (!project) continue;

        const adapter = await this.getAdapterForProject(project);

        // Set up real-time reporting
        adapter.hookIntoLifecycle({
          onTestStart: (testId) => {
            this.server.broadcast("test-run-update", {
              testId,
              status: "running",
            });
          },
          onTestEnd: (result) => {
            this.server.broadcast("test-result", result);
          },
          onFileStart: (file) => {
            console.log(`[Executor] Starting tests in: ${file}`);
          },
        });

        // Resolve project root to absolute path (Nx stores it as relative)
        const absoluteProjectRoot = path.isAbsolute(project.root)
          ? project.root
          : path.join(this.workspaceRoot, project.root);

        // Find the config file for this project
        const configPath = await this.resolveConfigPath(absoluteProjectRoot);

        const options: ExecutionOptions = {
          projectRoot: absoluteProjectRoot,
          configPath,
          instrumentation: {
            lineCoverage: false,
            branchCoverage: false,
            valueCapture: false,
            importTracing: false,
            functionTracing: false,
          },
          timeout: 30000,
        };

        console.log(
          `[Executor] Running ${testFiles.size === 0 ? "all" : testFiles.size} test(s) for project: ${projectName}`,
        );
        console.log(
          `[Executor] projectRoot: ${absoluteProjectRoot}, configPath: ${configPath}`,
        );

        // Start execution — results stream back via onTestEnd hook
        await adapter.executeTests(Array.from(testFiles), options);

        // Collect final results (including coverage)
        const finalResults = await adapter.collectResults();
        for (const result of finalResults.results) {
          this.server.broadcast("test-result", result);
        }
      }

      this.server.broadcast("test-run-complete", {
        timestamp: Date.now(),
        status: "success",
      });
    } catch (error: any) {
      console.error(`[Executor] Execution failed: ${error.message}`);
      this.server.broadcast("error", { message: error.message });
      this.server.broadcast("test-run-complete", {
        timestamp: Date.now(),
        status: "error",
        message: error.message,
      });
    } finally {
      this.server.broadcast("engine-status", "idle");
    }
  }

  private async groupTestsByProject(
    testFiles: Set<string>,
  ): Promise<Map<string, Set<string>>> {
    const groups = new Map<string, Set<string>>();
    for (const file of testFiles) {
      const projects = await this.projectMapper.mapFileToProjects(file);
      if (projects.length > 0) {
        const projectName = projects[0].name;
        if (!groups.has(projectName)) groups.set(projectName, new Set());
        groups.get(projectName)!.add(file);
      }
    }
    return groups;
  }

  private async getAdapterForProject(
    project: NxProjectInfo,
  ): Promise<TestFrameworkAdapter> {
    const framework = await AdapterAutoDetector.detectFramework(
      project,
      this.workspaceRoot,
    );
    // Always create a fresh adapter — the VitestAdapter creates a new Vitest instance
    // per executeTests() call and caching would cause stale hook references.
    let adapter: TestFrameworkAdapter;
    switch (framework) {
      case "vitest":
        adapter = new VitestAdapter();
        break;
      case "jest":
        adapter = new JestAdapter();
        break;
      case "jasmine":
        adapter = new JasmineAdapter();
        break;
      default:
        throw new Error(`Unsupported framework: ${framework}`);
    }
    return adapter;
  }

  /**
   * Find the test config file for a project (absolute path).
   * Checks for vitest.config.ts, vite.config.ts, jest.config.ts, etc.
   */
  private async resolveConfigPath(
    absoluteProjectRoot: string,
  ): Promise<string | null> {
    const candidates = [
      "vitest.config.ts",
      "vitest.config.js",
      "vite.config.ts",
      "jest.config.ts",
      "jest.config.js",
      "jest.config.cjs",
    ];
    for (const name of candidates) {
      const full = path.join(absoluteProjectRoot, name);
      try {
        await fs.access(full);
        return full;
      } catch {
        // not found, try next
      }
    }
    return null;
  }
}
