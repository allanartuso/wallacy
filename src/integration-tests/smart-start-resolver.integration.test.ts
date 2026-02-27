/**
 * Integration tests for SmartStartResolver.
 *
 * Tests the full resolution pipeline:
 *   file → project → framework → config → tsconfig → path aliases
 *
 * Uses real file system fixtures representing different workspace layouts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Container from "typedi";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {FileToProjectMapper} from "../core-engine/nx-resolver/file-mapper";
import {NxDevkitBridge, NxProjectGraph, NxWorkspaceResolver} from "../core-engine/nx-resolver/workspace-resolver";
import {SmartStartResolver} from "../core-engine/smart-start/smart-start-resolver";

// ─── Helpers ────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wallacy-test-smart-start-"));
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

/**
 * Create a mock NxDevkitBridge that returns a predefined project graph.
 */
function createMockBridge(graph: NxProjectGraph): NxDevkitBridge {
  return {
    async createProjectGraphAsync(): Promise<NxProjectGraph> {
      return graph;
    },
  };
}

/**
 * Set up the DI container with a workspace resolver that uses the given
 * tmpDir as workspace root and the provided Nx project graph.
 */
function setupContainer(tmpDir: string, graph: NxProjectGraph): void {
  const resolver = new NxWorkspaceResolver();
  resolver.setWorkspaceRoot(tmpDir);
  resolver.setDevkitBridge(createMockBridge(graph));
  Container.set(NxWorkspaceResolver, resolver);
  Container.set(FileToProjectMapper, new FileToProjectMapper());
}

// ─── Tests ──────────────────────────────────────────────────

describe("SmartStartResolver", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
    Container.reset();
  });

  // ─── Nx monorepo with vitest ──────────────────────────

  describe("Nx monorepo with vitest", () => {
    it("should resolve project, framework, config, and tsconfig for a vitest project", async () => {
      // Setup Nx workspace structure
      writeFile(tmpDir, "nx.json", JSON.stringify({npmScope: "myorg"}));
      writeFile(
        tmpDir,
        "tsconfig.base.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@myorg/shared": ["libs/shared/src/index.ts"],
              "@myorg/shared/*": ["libs/shared/src/*"],
            },
          },
        }),
      );
      writeFile(
        tmpDir,
        "apps/frontend/tsconfig.json",
        JSON.stringify({
          extends: "../../tsconfig.base.json",
          compilerOptions: {},
        }),
      );
      writeFile(tmpDir, "apps/frontend/vitest.config.ts", "export default { test: { globals: true } }");
      const testFile = writeFile(
        tmpDir,
        "apps/frontend/src/app.spec.ts",
        '// test file\nimport { something } from "@myorg/shared";',
      );

      // Mock Nx project graph
      const graph: NxProjectGraph = {
        nodes: {
          frontend: {
            name: "frontend",
            type: "app",
            data: {
              root: "apps/frontend",
              sourceRoot: "apps/frontend/src",
              targets: {
                test: {
                  executor: "@nx/vite:test",
                  options: {},
                },
              },
              tags: [],
            },
          },
          shared: {
            name: "shared",
            type: "lib",
            data: {
              root: "libs/shared",
              sourceRoot: "libs/shared/src",
              targets: {},
              tags: [],
            },
          },
        },
        dependencies: {
          frontend: [{source: "frontend", target: "shared", type: "static"}],
          shared: [],
        },
      };

      const bridge = createMockBridge(graph);
      setupContainer(tmpDir, graph);
      const resolver = new SmartStartResolver();

      const result = await resolver.resolve(testFile, false);

      expect(result.project.name).toBe("frontend");
      expect(result.testFramework).toBe("vitest");
      expect(result.configPath).toBe(path.join(tmpDir, "apps", "frontend", "vitest.config.ts"));
      expect(result.tsconfigPath).toBe(path.join(tmpDir, "apps", "frontend", "tsconfig.json"));
      expect(result.pathAliases["@myorg/shared"]).toEqual([path.join(tmpDir, "libs/shared/src/index.ts")]);
      expect(result.pathAliases["@myorg/shared/*"]).toEqual([path.join(tmpDir, "libs/shared/src/*")]);
    });

    it("should compute transitive dependents", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "libs/shared/tsconfig.json", JSON.stringify({compilerOptions: {}}));
      writeFile(tmpDir, "libs/shared/vitest.config.ts", "export default {}");
      const testFile = writeFile(tmpDir, "libs/shared/src/utils.spec.ts", "// test");

      const graph: NxProjectGraph = {
        nodes: {
          shared: {
            name: "shared",
            type: "lib",
            data: {
              root: "libs/shared",
              sourceRoot: "libs/shared/src",
              targets: {
                test: {executor: "@nx/vite:test"},
              },
              tags: [],
            },
          },
          frontend: {
            name: "frontend",
            type: "app",
            data: {
              root: "apps/frontend",
              sourceRoot: "apps/frontend/src",
              targets: {},
              tags: [],
            },
          },
          backend: {
            name: "backend",
            type: "app",
            data: {
              root: "apps/backend",
              sourceRoot: "apps/backend/src",
              targets: {},
              tags: [],
            },
          },
        },
        dependencies: {
          shared: [],
          frontend: [{source: "frontend", target: "shared", type: "static"}],
          backend: [{source: "backend", target: "shared", type: "static"}],
        },
      };

      const bridge = createMockBridge(graph);
      setupContainer(tmpDir, graph);
      const resolver = new SmartStartResolver();

      const result = await resolver.resolve(testFile, true);

      expect(result.project.name).toBe("shared");
      expect(result.dependents).toContain("frontend");
      expect(result.dependents).toContain("backend");
      expect(result.dependents).toHaveLength(2);
    });
  });

  // ─── Nx monorepo with jest ────────────────────────────

  describe("Nx monorepo with jest", () => {
    it("should resolve jest framework from executor", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/api/tsconfig.json", JSON.stringify({compilerOptions: {}}));
      writeFile(tmpDir, "apps/api/jest.config.ts", "export default { preset: '../../jest.preset.js' }");
      const testFile = writeFile(tmpDir, "apps/api/src/app.spec.ts", "// test");

      const graph: NxProjectGraph = {
        nodes: {
          api: {
            name: "api",
            type: "app",
            data: {
              root: "apps/api",
              sourceRoot: "apps/api/src",
              targets: {
                test: {
                  executor: "@nx/jest:jest",
                  options: {
                    jestConfig: "apps/api/jest.config.ts",
                  },
                },
              },
              tags: [],
            },
          },
        },
        dependencies: {api: []},
      };

      const bridge = createMockBridge(graph);
      setupContainer(tmpDir, graph);
      const resolver = new SmartStartResolver();

      const result = await resolver.resolve(testFile, false);

      expect(result.project.name).toBe("api");
      expect(result.testFramework).toBe("jest");
      expect(result.testTarget).toBe("test");
    });
  });

  // ─── Non-Nx single project ────────────────────────────

  describe("non-Nx single project", () => {
    it("should resolve a standalone vitest project", async () => {
      writeFile(
        tmpDir,
        "package.json",
        JSON.stringify({
          name: "my-project",
          devDependencies: {vitest: "^1.0.0"},
        }),
      );
      writeFile(
        tmpDir,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["src/*"],
            },
          },
        }),
      );
      writeFile(tmpDir, "vitest.config.ts", "export default {}");
      const testFile = writeFile(tmpDir, "src/__tests__/utils.spec.ts", "// test");

      // Empty Nx graph (not an Nx workspace)
      const bridge = createMockBridge({nodes: {}, dependencies: {}});
      setupContainer(tmpDir, {nodes: {}, dependencies: {}});
      const resolver = new SmartStartResolver();

      const result = await resolver.resolve(testFile, false);

      expect(result.testFramework).toBe("vitest");
      expect(result.configPath).toBe(path.join(tmpDir, "vitest.config.ts"));
      expect(result.tsconfigPath).toBe(path.join(tmpDir, "tsconfig.json"));
      expect(result.pathAliases["@/*"]).toEqual([path.join(tmpDir, "src/*")]);
    });

    it("should resolve a standalone jest project", async () => {
      writeFile(
        tmpDir,
        "package.json",
        JSON.stringify({
          name: "my-jest-project",
          devDependencies: {jest: "^29.0.0", "ts-jest": "^29.0.0"},
        }),
      );
      writeFile(tmpDir, "tsconfig.json", JSON.stringify({compilerOptions: {}}));
      writeFile(tmpDir, "jest.config.ts", "export default {}");
      const testFile = writeFile(tmpDir, "src/app.test.ts", "// test");

      const bridge = createMockBridge({nodes: {}, dependencies: {}});
      setupContainer(tmpDir, {nodes: {}, dependencies: {}});
      const resolver = new SmartStartResolver();

      const result = await resolver.resolve(testFile, false);

      expect(result.testFramework).toBe("jest");
      expect(result.configPath).toBe(path.join(tmpDir, "jest.config.ts"));
      expect(result.tsconfigPath).toBe(path.join(tmpDir, "tsconfig.json"));
    });

    it("should fallback to dependency detection when no config file exists", async () => {
      writeFile(
        tmpDir,
        "package.json",
        JSON.stringify({
          name: "minimal-project",
          devDependencies: {vitest: "^1.0.0"},
        }),
      );
      writeFile(tmpDir, "tsconfig.json", JSON.stringify({compilerOptions: {}}));
      const testFile = writeFile(tmpDir, "src/app.spec.ts", "// test");

      const bridge = createMockBridge({nodes: {}, dependencies: {}});
      setupContainer(tmpDir, {nodes: {}, dependencies: {}});
      const resolver = new SmartStartResolver();

      const result = await resolver.resolve(testFile, false);

      // Should detect vitest from package.json deps
      expect(result.testFramework).toBe("vitest");
      expect(result.tsconfigPath).toBe(path.join(tmpDir, "tsconfig.json"));
    });
  });

  // ─── tsconfig extends chain ───────────────────────────

  describe("tsconfig extends chain", () => {
    it("should resolve path aliases through extends chain in Nx", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(
        tmpDir,
        "tsconfig.base.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@myorg/core": ["libs/core/src/index.ts"],
              "@myorg/core/*": ["libs/core/src/*"],
            },
          },
        }),
      );
      writeFile(
        tmpDir,
        "libs/core/tsconfig.json",
        JSON.stringify({
          extends: "../../tsconfig.base.json",
          compilerOptions: {},
        }),
      );
      writeFile(tmpDir, "libs/core/vitest.config.ts", "export default {}");
      const testFile = writeFile(tmpDir, "libs/core/src/utils.spec.ts", "// test");

      const graph: NxProjectGraph = {
        nodes: {
          core: {
            name: "core",
            type: "lib",
            data: {
              root: "libs/core",
              sourceRoot: "libs/core/src",
              targets: {
                test: {executor: "@nx/vite:test"},
              },
              tags: [],
            },
          },
        },
        dependencies: {core: []},
      };

      const bridge = createMockBridge(graph);
      setupContainer(tmpDir, graph);
      const resolver = new SmartStartResolver();

      const result = await resolver.resolve(testFile, false);

      expect(result.tsconfigPath).toBe(path.join(tmpDir, "libs", "core", "tsconfig.json"));
      expect(result.pathAliases["@myorg/core"]).toEqual([path.join(tmpDir, "libs/core/src/index.ts")]);
      expect(result.pathAliases["@myorg/core/*"]).toEqual([path.join(tmpDir, "libs/core/src/*")]);
    });
  });

  // ─── Error cases ──────────────────────────────────────

  describe("error cases", () => {
    it("should fall back to file-system discovery when file is not in any Nx project graph node", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      const testFile = writeFile(tmpDir, "random/orphan.spec.ts", "// orphan test");

      // Nx workspace with no projects that own this file
      const graph: NxProjectGraph = {
        nodes: {
          app: {
            name: "app",
            type: "app",
            data: {
              root: "apps/app",
              sourceRoot: "apps/app/src",
              targets: {},
              tags: [],
            },
          },
        },
        dependencies: {app: []},
      };

      const bridge = createMockBridge(graph);
      setupContainer(tmpDir, graph);
      const resolver = new SmartStartResolver();

      // With the fallback to file-system discovery, the file is resolved
      // against the workspace root as a synthetic project
      const result = await resolver.resolve(testFile, false);
      expect(result.project.root).toBe(tmpDir);
      expect(result.project.name).toBe(path.basename(tmpDir));
    });
  });
});
