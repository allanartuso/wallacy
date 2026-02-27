/**
 * Integration tests for SmartStartExecutor.
 *
 * Tests the full execute pipeline:
 *   file → resolve project/framework/config → discover tests → execute → results
 *
 * Uses real file-system fixtures and mock Nx project graphs.
 * The adapters' executeTests() methods are lightweight stubs so the tests
 * exercise the wiring without starting real vitest/jest processes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Container from "typedi";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {FileToProjectMapper} from "../core-engine/nx-resolver/file-mapper";
import {NxDevkitBridge, NxProjectGraph, NxWorkspaceResolver} from "../core-engine/nx-resolver/workspace-resolver";
import {SmartStartResolver} from "../core-engine/smart-start/smart-start-resolver";
import type {CollectedResults, SmartStartResult, TestInfo} from "../shared-types";
import {SmartStartCallbacks, SmartStartExecutor} from "../smart-start-executor";

// ─── Helpers ────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wallacy-exec-test-"));
}

function writeFile(dir: string, relativePath: string, content: string): string {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), {recursive: true});
  fs.writeFileSync(fullPath, content, "utf-8");
  return fullPath;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, {recursive: true, force: true});
}

function createMockBridge(graph: NxProjectGraph): NxDevkitBridge {
  return {
    async createProjectGraphAsync(): Promise<NxProjectGraph> {
      return graph;
    },
  };
}

/**
 * Build a simple single-project Nx graph for vitest.
 */
function singleVitestProject(projectName = "my-app", projectRoot = "apps/my-app"): NxProjectGraph {
  return {
    nodes: {
      [projectName]: {
        name: projectName,
        type: "app",
        data: {
          root: projectRoot,
          sourceRoot: `${projectRoot}/src`,
          targets: {
            test: {
              executor: "@nx/vite:test",
              options: {},
            },
          },
          tags: [],
        },
      },
    },
    dependencies: {
      [projectName]: [],
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe("SmartStartExecutor", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
    Container.reset();
  });

  // ─── Resolution + Discovery ─────────────────────────────

  describe("full execute pipeline", () => {
    it("should resolve project, discover tests, and return results for a vitest project", async () => {
      // Setup workspace
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/my-app/vitest.config.ts", "export default { test: { globals: true } }");
      writeFile(tmpDir, "apps/my-app/tsconfig.json", JSON.stringify({compilerOptions: {strict: true}}));
      const testFile = writeFile(
        tmpDir,
        "apps/my-app/src/calculator.test.ts",
        `
import { describe, it, expect } from "vitest";
describe("Calculator", () => {
  it("should add numbers", () => {
    expect(1 + 2).toBe(3);
  });
});
`,
      );

      const graph = singleVitestProject();
      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();
      const result = await executor.execute(testFile);

      // Resolution assertions
      expect(result.resolution).toBeDefined();
      expect(result.resolution.project.name).toBe("my-app");
      expect(result.resolution.testFramework).toBe("vitest");
      expect(result.resolution.configPath).toBe(path.join(tmpDir, "apps", "my-app", "vitest.config.ts"));
      expect(result.resolution.tsconfigPath).toBe(path.join(tmpDir, "apps", "my-app", "tsconfig.json"));

      // Discovery assertions — the test file should be discovered
      expect(result.tests.length).toBeGreaterThanOrEqual(1);
      const discoveredFiles = result.tests.map((t) => t.file);
      // Normalize paths for comparison (Windows backslash vs forward slash)
      const normalizedDiscoveredFiles = discoveredFiles.map((f) => f.replace(/\\/g, "/").toLowerCase());
      expect(normalizedDiscoveredFiles.some((f) => f.includes("calculator.test.ts"))).toBe(true);

      // Collected results structure exists (adapter stubs may return empty)
      expect(result.collected).toBeDefined();
      expect(result.collected).toHaveProperty("results");
      expect(result.collected).toHaveProperty("coverage");
      expect(result.collected).toHaveProperty("duration");
    });

    it("should resolve a jest project and go through the execute pipeline", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/api/jest.config.ts", "export default { preset: 'ts-jest' }");
      const testFile = writeFile(tmpDir, "apps/api/src/service.spec.ts", "// jest test");

      const graph: NxProjectGraph = {
        nodes: {
          api: {
            name: "api",
            type: "app",
            data: {
              root: "apps/api",
              sourceRoot: "apps/api/src",
              targets: {
                test: {executor: "@nx/jest:jest", options: {}},
              },
              tags: [],
            },
          },
        },
        dependencies: {api: []},
      };

      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();
      const result = await executor.execute(testFile);

      expect(result.resolution.project.name).toBe("api");
      expect(result.resolution.testFramework).toBe("jest");
      expect(result.resolution.configPath).toBe(path.join(tmpDir, "apps", "api", "jest.config.ts"));

      // Jest adapter now discovers test files via filesystem scan
      expect(result.tests.length).toBeGreaterThanOrEqual(1);
      // executeTests will fail (no actual jest installed in temp) — results may be error entries
      expect(result.results).toBeDefined();
    });

    it("should resolve a jasmine project and go through the execute pipeline", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(
        tmpDir,
        "apps/legacy/spec/support/jasmine.json",
        JSON.stringify({spec_dir: "spec", spec_files: ["**/*[sS]pec.ts"]}),
      );
      const testFile = writeFile(tmpDir, "apps/legacy/spec/widget.spec.ts", "// jasmine test");

      const graph: NxProjectGraph = {
        nodes: {
          legacy: {
            name: "legacy",
            type: "app",
            data: {
              root: "apps/legacy",
              sourceRoot: "apps/legacy/src",
              targets: {},
              tags: [],
            },
          },
        },
        dependencies: {legacy: []},
      };

      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();
      const result = await executor.execute(testFile);

      expect(result.resolution.project.name).toBe("legacy");
      expect(result.resolution.testFramework).toBe("jasmine");
    });
  });

  // ─── Callbacks ──────────────────────────────────────────

  describe("callbacks", () => {
    it("should fire onResolved callback with the resolution result", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/ui/vitest.config.ts", "export default {}");
      const testFile = writeFile(tmpDir, "apps/ui/src/button.test.ts", "// test");

      const graph = singleVitestProject("ui", "apps/ui");
      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();

      let resolvedResult: SmartStartResult | null = null;
      const callbacks: SmartStartCallbacks = {
        onResolved: (result) => {
          resolvedResult = result;
        },
      };

      await executor.execute(testFile, callbacks);

      expect(resolvedResult).not.toBeNull();
      expect(resolvedResult!.project.name).toBe("ui");
      expect(resolvedResult!.testFramework).toBe("vitest");
    });

    it("should fire onTestsDiscovered callback", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/ui/vitest.config.ts", "export default {}");
      writeFile(tmpDir, "apps/ui/src/button.test.ts", "// test");
      const testFile = writeFile(tmpDir, "apps/ui/src/input.test.ts", "// test 2");

      const graph = singleVitestProject("ui", "apps/ui");
      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();

      let discoveredTests: TestInfo[] = [];
      const callbacks: SmartStartCallbacks = {
        onTestsDiscovered: (tests) => {
          discoveredTests = tests;
        },
      };

      await executor.execute(testFile, callbacks);

      // Should discover both test files in the project
      expect(discoveredTests.length).toBeGreaterThanOrEqual(2);
    });

    it("should fire onLog callback throughout the pipeline", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/ui/vitest.config.ts", "export default {}");
      const testFile = writeFile(tmpDir, "apps/ui/src/button.test.ts", "// test");

      const graph = singleVitestProject("ui", "apps/ui");
      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();

      const logs: string[] = [];
      const callbacks: SmartStartCallbacks = {
        onLog: (msg) => logs.push(msg),
      };

      await executor.execute(testFile, callbacks);

      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some((l) => l.includes("Resolving"))).toBe(true);
      expect(logs.some((l) => l.includes("Resolved"))).toBe(true);
      expect(logs.some((l) => l.includes("Discovering tests"))).toBe(true);
      expect(logs.some((l) => l.includes("Running tests"))).toBe(true);
      expect(logs.some((l) => l.includes("Run complete"))).toBe(true);
    });

    it("should fire onRunComplete callback", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/ui/vitest.config.ts", "export default {}");
      const testFile = writeFile(tmpDir, "apps/ui/src/button.test.ts", "// test");

      const graph = singleVitestProject("ui", "apps/ui");
      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();

      let runComplete: CollectedResults | null = null;
      const callbacks: SmartStartCallbacks = {
        onRunComplete: (collected) => {
          runComplete = collected;
        },
      };

      await executor.execute(testFile, callbacks);

      expect(runComplete).not.toBeNull();
      expect(runComplete).toHaveProperty("results");
      expect(runComplete).toHaveProperty("coverage");
      expect(runComplete).toHaveProperty("duration");
    });

    it("should resolve orphan file via file-system fallback when Nx graph has no matching project", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      // No projects defined in the graph — file will be resolved via file-system fallback
      const testFile = writeFile(tmpDir, "orphan/test.spec.ts", "// test");

      const graph: NxProjectGraph = {nodes: {}, dependencies: {}};
      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();

      let resolvedResult: SmartStartResult | null = null;
      const callbacks: SmartStartCallbacks = {
        onResolved: (result) => {
          resolvedResult = result;
        },
      };

      // Should NOT throw — falls back to file-system discovery
      const result = await executor.execute(testFile, callbacks);
      expect(resolvedResult).not.toBeNull();
      expect(resolvedResult!.project.root).toBe(tmpDir);
      expect(result.resolution.project.name).toBe(path.basename(tmpDir));
    });
  });

  // ─── resolve-only mode ────────────────────────────────────

  describe("resolve-only", () => {
    it("should resolve without running tests", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/ui/vitest.config.ts", "export default {}");
      writeFile(
        tmpDir,
        "apps/ui/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {"@ui/*": ["src/*"]},
          },
        }),
      );
      const testFile = writeFile(tmpDir, "apps/ui/src/button.test.ts", "// test");

      const graph = singleVitestProject("ui", "apps/ui");
      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();
      const result = await executor.resolve(testFile);

      expect(result.project.name).toBe("ui");
      expect(result.testFramework).toBe("vitest");
      expect(result.configPath).toBe(path.join(tmpDir, "apps", "ui", "vitest.config.ts"));
      expect(result.tsconfigPath).toBe(path.join(tmpDir, "apps", "ui", "tsconfig.json"));
      expect(result.pathAliases["@ui/*"]).toEqual(["src/*"]);
    });
  });

  // ─── tsconfig resolution in execute pipeline ──────────────

  describe("tsconfig integration", () => {
    it("should propagate tsconfig path and path aliases through the full pipeline", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(
        tmpDir,
        "tsconfig.base.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@shared/*": ["libs/shared/src/*"],
            },
          },
        }),
      );
      writeFile(
        tmpDir,
        "apps/portal/tsconfig.json",
        JSON.stringify({
          extends: "../../tsconfig.base.json",
          compilerOptions: {
            outDir: "dist",
          },
        }),
      );
      writeFile(tmpDir, "apps/portal/vitest.config.ts", "export default {}");
      const testFile = writeFile(tmpDir, "apps/portal/src/app.test.ts", "// test with imports");

      const graph = singleVitestProject("portal", "apps/portal");
      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();
      const result = await executor.execute(testFile);

      expect(result.resolution.tsconfigPath).toBe(path.join(tmpDir, "apps", "portal", "tsconfig.json"));
      // Path aliases should be resolved from the extends chain
      expect(result.resolution.pathAliases["@shared/*"]).toEqual(["libs/shared/src/*"]);
    });
  });

  // ─── Edge cases ──────────────────────────────────────────

  describe("edge cases", () => {
    it("should fall back to jest when no framework config is found", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      // No config files at all — resolver will fallback-detect framework
      const testFile = writeFile(tmpDir, "apps/bare/src/index.test.ts", "// test");

      const graph: NxProjectGraph = {
        nodes: {
          bare: {
            name: "bare",
            type: "app",
            data: {
              root: "apps/bare",
              sourceRoot: "apps/bare/src",
              targets: {},
              tags: [],
            },
          },
        },
        dependencies: {bare: []},
      };

      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();

      // SmartStartResolver falls back to "jest" when no framework config is detected
      const result = await executor.execute(testFile);
      expect(result.resolution.testFramework).toBe("jest");
      expect(result.resolution.configPath).toBeNull();
      // Jest adapter now discovers test files via filesystem scan
      expect(result.tests.length).toBeGreaterThanOrEqual(1);
      // executeTests will produce error entries (no jest installed in temp dir)
      expect(result.results).toBeDefined();
    });

    it("should handle multiple test files in the project", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/multi/vitest.config.ts", "export default {}");
      writeFile(tmpDir, "apps/multi/src/a.test.ts", "// a");
      writeFile(tmpDir, "apps/multi/src/b.test.ts", "// b");
      writeFile(tmpDir, "apps/multi/src/c.spec.ts", "// c");
      const testFile = writeFile(tmpDir, "apps/multi/src/a.test.ts", "// a");

      const graph = singleVitestProject("multi", "apps/multi");
      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();
      const result = await executor.execute(testFile);

      // Should discover all 3 test files
      expect(result.tests.length).toBeGreaterThanOrEqual(3);
    });

    it("should work without a tsconfig in the project", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/noconfig/vitest.config.ts", "export default {}");
      const testFile = writeFile(tmpDir, "apps/noconfig/src/index.test.ts", "// test");

      const graph = singleVitestProject("noconfig", "apps/noconfig");
      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver());
      Container.set(FileToProjectMapper, new FileToProjectMapper());
      Container.set(SmartStartResolver, new SmartStartResolver());
      const executor = new SmartStartExecutor();
      const result = await executor.execute(testFile);

      expect(result.resolution.project.name).toBe("noconfig");
      expect(result.resolution.tsconfigPath).toBeNull();
      expect(result.resolution.pathAliases).toEqual({});
    });
  });
});
