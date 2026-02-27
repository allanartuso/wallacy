/**
 * Integration tests for FileToProjectMapper.
 *
 * Tests file-to-project mapping for both Nx and non-Nx workspaces.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Container from "typedi";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {FileToProjectMapper} from "../core-engine/nx-resolver/file-mapper";
import {NxDevkitBridge, NxProjectGraph, NxWorkspaceResolver} from "../core-engine/nx-resolver/workspace-resolver";

// ─── Helpers ────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wallacy-test-mapper-"));
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

// ─── Tests ──────────────────────────────────────────────────

describe("FileToProjectMapper", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
    Container.reset();
  });

  // ─── Nx workspace ─────────────────────────────────────

  describe("Nx workspace", () => {
    it("should map file to correct Nx project", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/frontend/src/app.spec.ts", "// test");

      const graph: NxProjectGraph = {
        nodes: {
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
        dependencies: {},
      };

      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver(tmpDir, bridge));
      const mapper = new FileToProjectMapper();

      const projects = await mapper.mapFileToProjects(path.join(tmpDir, "apps", "frontend", "src", "app.spec.ts"));

      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("frontend");
    });

    it("should pick deepest project for nested project structures", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/frontend/feature-x/src/test.spec.ts", "// test");

      const graph: NxProjectGraph = {
        nodes: {
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
          "frontend-feature-x": {
            name: "frontend-feature-x",
            type: "lib",
            data: {
              root: "apps/frontend/feature-x",
              sourceRoot: "apps/frontend/feature-x/src",
              targets: {},
              tags: [],
            },
          },
        },
        dependencies: {},
      };

      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver(tmpDir, bridge));
      const mapper = new FileToProjectMapper();

      const projects = await mapper.mapFileToProjects(
        path.join(tmpDir, "apps", "frontend", "feature-x", "src", "test.spec.ts"),
      );

      // Deepest project should be first
      expect(projects.length).toBeGreaterThanOrEqual(1);
      expect(projects[0].name).toBe("frontend-feature-x");
    });

    it("should throw for file not in any project", async () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "random/test.spec.ts", "// test");

      const graph: NxProjectGraph = {
        nodes: {
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
        },
        dependencies: {},
      };

      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver(tmpDir, bridge));
      const mapper = new FileToProjectMapper();

      // With the fallback to file-system discovery, the file is now mapped
      // to the workspace root as a synthetic project instead of throwing
      const project = await mapper.mapFileToProjectOrThrow(path.join(tmpDir, "random", "test.spec.ts"));
      expect(project.root).toBe(tmpDir);
      expect(project.name).toBe(path.basename(tmpDir));
    });
  });

  // ─── Non-Nx workspace ─────────────────────────────────

  describe("non-Nx workspace (file system discovery)", () => {
    it("should discover project root from package.json", async () => {
      writeFile(tmpDir, "package.json", JSON.stringify({name: "my-project"}));
      writeFile(tmpDir, "src/app.spec.ts", "// test");

      // No Nx config — empty graph
      const bridge = createMockBridge({nodes: {}, dependencies: {}});
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver(tmpDir, bridge));
      const mapper = new FileToProjectMapper();

      const projects = await mapper.mapFileToProjects(path.join(tmpDir, "src", "app.spec.ts"));

      expect(projects).toHaveLength(1);
      expect(projects[0].root).toBe(tmpDir);
    });

    it("should discover project root from vitest.config.ts", async () => {
      writeFile(tmpDir, "vitest.config.ts", "export default {}");
      writeFile(tmpDir, "src/deep/nested/test.spec.ts", "// test");

      const bridge = createMockBridge({nodes: {}, dependencies: {}});
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver(tmpDir, bridge));
      const mapper = new FileToProjectMapper();

      const projects = await mapper.mapFileToProjects(path.join(tmpDir, "src", "deep", "nested", "test.spec.ts"));

      expect(projects).toHaveLength(1);
    });

    it("should create synthetic project without biased executor", async () => {
      writeFile(tmpDir, "package.json", JSON.stringify({name: "neutral-project"}));
      writeFile(tmpDir, "src/test.spec.ts", "// test");

      const bridge = createMockBridge({nodes: {}, dependencies: {}});
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver(tmpDir, bridge));
      const mapper = new FileToProjectMapper();

      const projects = await mapper.mapFileToProjects(path.join(tmpDir, "src", "test.spec.ts"));

      expect(projects).toHaveLength(1);
      // Verify no hardcoded vitest executor
      expect(projects[0].targets).toEqual({});
    });
  });

  // ─── getAffectedProjects ──────────────────────────────

  describe("getAffectedProjects", () => {
    it("should return unique affected projects for multiple files", async () => {
      writeFile(tmpDir, "nx.json", "{}");

      const graph: NxProjectGraph = {
        nodes: {
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
        dependencies: {},
      };

      writeFile(tmpDir, "apps/frontend/src/a.spec.ts", "// test");
      writeFile(tmpDir, "apps/frontend/src/b.spec.ts", "// test");
      writeFile(tmpDir, "libs/shared/src/c.spec.ts", "// test");

      const bridge = createMockBridge(graph);
      Container.set(NxWorkspaceResolver, new NxWorkspaceResolver(tmpDir, bridge));
      const mapper = new FileToProjectMapper();

      const affected = await mapper.getAffectedProjects([
        path.join(tmpDir, "apps", "frontend", "src", "a.spec.ts"),
        path.join(tmpDir, "apps", "frontend", "src", "b.spec.ts"),
        path.join(tmpDir, "libs", "shared", "src", "c.spec.ts"),
      ]);

      expect(affected).toHaveLength(2);
      const names = affected.map((p) => p.name);
      expect(names).toContain("frontend");
      expect(names).toContain("shared");
    });
  });
});
