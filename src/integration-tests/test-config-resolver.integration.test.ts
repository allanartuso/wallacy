/**
 * Integration tests for TestConfigResolver.
 *
 * Creates real file system fixtures to test test framework
 * config discovery across different project layouts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {TestConfigResolver} from "../core-engine/config/test-config-resolver";

// ─── Helpers ────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wallacy-test-config-"));
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

// ─── Tests ──────────────────────────────────────────────────

describe("TestConfigResolver", () => {
  let resolver: TestConfigResolver;
  let tmpDir: string;

  beforeEach(() => {
    resolver = new TestConfigResolver();
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ─── Single project layouts ────────────────────────────

  describe("single project with vitest", () => {
    it("should find vitest.config.ts at project root", () => {
      writeFile(tmpDir, "vitest.config.ts", "export default {}");
      writeFile(tmpDir, "src/__tests__/app.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "src", "__tests__", "app.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("vitest");
      expect(result!.configPath).toBe(path.join(tmpDir, "vitest.config.ts"));
      expect(result!.isWorkspaceConfig).toBe(false);
    });

    it("should find vitest.config.mts at project root", () => {
      writeFile(tmpDir, "vitest.config.mts", "export default {}");
      writeFile(tmpDir, "src/test.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "src", "test.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("vitest");
    });
  });

  describe("single project with jest", () => {
    it("should find jest.config.ts at project root", () => {
      writeFile(tmpDir, "jest.config.ts", "export default {}");
      writeFile(tmpDir, "src/__tests__/app.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "src", "__tests__", "app.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("jest");
      expect(result!.configPath).toBe(path.join(tmpDir, "jest.config.ts"));
    });

    it("should find jest.config.json at project root", () => {
      writeFile(tmpDir, "jest.config.json", "{}");
      writeFile(tmpDir, "src/app.test.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "src", "app.test.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("jest");
    });
  });

  describe("single project with jasmine", () => {
    it("should find jasmine.json at project root", () => {
      writeFile(tmpDir, "jasmine.json", "{}");
      writeFile(tmpDir, "src/app.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "src", "app.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("jasmine");
    });

    it("should find jasmine.json in spec/support directory", () => {
      writeFile(tmpDir, "spec/support/jasmine.json", "{}");
      writeFile(tmpDir, "src/app.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "src", "app.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("jasmine");
    });
  });

  // ─── Nx monorepo layouts ──────────────────────────────

  describe("Nx monorepo with vitest", () => {
    it("should find vitest.config.ts in Nx project directory", () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/my-app/vitest.config.ts", "export default {}");
      writeFile(tmpDir, "apps/my-app/src/app.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "apps", "my-app", "src", "app.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("vitest");
      expect(result!.configPath).toBe(path.join(tmpDir, "apps", "my-app", "vitest.config.ts"));
    });

    it("should find vitest.workspace.ts at workspace root as fallback", () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "vitest.workspace.ts", "export default []");
      writeFile(tmpDir, "apps/my-app/src/app.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "apps", "my-app", "src", "app.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("vitest");
      expect(result!.configPath).toBe(path.join(tmpDir, "vitest.workspace.ts"));
      expect(result!.isWorkspaceConfig).toBe(true);
    });

    it("should prefer project-level config over workspace-level config", () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "vitest.workspace.ts", "export default []");
      writeFile(tmpDir, "apps/my-app/vitest.config.ts", "export default {}");
      writeFile(tmpDir, "apps/my-app/src/app.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "apps", "my-app", "src", "app.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("vitest");
      expect(result!.configPath).toBe(path.join(tmpDir, "apps", "my-app", "vitest.config.ts"));
      expect(result!.isWorkspaceConfig).toBe(false);
    });
  });

  describe("Nx monorepo with jest", () => {
    it("should find jest.config.ts in Nx project directory", () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "jest.preset.js", "module.exports = {}");
      writeFile(tmpDir, "apps/api/jest.config.ts", "export default {}");
      writeFile(tmpDir, "apps/api/src/app.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "apps", "api", "src", "app.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("jest");
      expect(result!.configPath).toBe(path.join(tmpDir, "apps", "api", "jest.config.ts"));
    });

    it("should find jest.preset.js at workspace root as fallback", () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "jest.preset.js", "module.exports = {}");
      writeFile(tmpDir, "apps/api/src/app.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "apps", "api", "src", "app.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("jest");
      expect(result!.isWorkspaceConfig).toBe(true);
    });
  });

  describe("Nx monorepo with mixed frameworks", () => {
    it("should detect correct framework for each project", () => {
      writeFile(tmpDir, "nx.json", "{}");
      writeFile(tmpDir, "apps/frontend/vitest.config.ts", "export default {}");
      writeFile(tmpDir, "apps/backend/jest.config.ts", "export default {}");
      writeFile(tmpDir, "apps/frontend/src/app.spec.ts", "// test");
      writeFile(tmpDir, "apps/backend/src/app.spec.ts", "// test");

      const frontendResult = resolver.findClosestTestConfig(
        path.join(tmpDir, "apps", "frontend", "src", "app.spec.ts"),
        tmpDir,
      );
      const backendResult = resolver.findClosestTestConfig(
        path.join(tmpDir, "apps", "backend", "src", "app.spec.ts"),
        tmpDir,
      );

      expect(frontendResult!.framework).toBe("vitest");
      expect(backendResult!.framework).toBe("jest");
    });
  });

  // ─── vite.config.ts with vitest ───────────────────────

  describe("vite.config.ts with vitest", () => {
    it("should detect vitest from vite.config.ts", () => {
      writeFile(
        tmpDir,
        "vite.config.ts",
        `import { defineConfig } from 'vite';
export default defineConfig({ test: { globals: true } });`,
      );
      writeFile(tmpDir, "src/app.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "src", "app.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("vitest");
    });

    it("should prefer vitest.config.ts over vite.config.ts", () => {
      writeFile(tmpDir, "vitest.config.ts", "export default {}");
      writeFile(tmpDir, "vite.config.ts", "export default {}");
      writeFile(tmpDir, "src/app.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "src", "app.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.configPath).toBe(path.join(tmpDir, "vitest.config.ts"));
    });
  });

  // ─── Preferred framework ──────────────────────────────

  describe("preferred framework", () => {
    it("should prefer specified framework when multiple configs exist", () => {
      writeFile(tmpDir, "vitest.config.ts", "export default {}");
      writeFile(tmpDir, "jest.config.ts", "export default {}");
      writeFile(tmpDir, "src/app.spec.ts", "// test");

      const resultJest = resolver.findClosestTestConfig(path.join(tmpDir, "src", "app.spec.ts"), tmpDir, "jest");

      expect(resultJest).not.toBeNull();
      expect(resultJest!.framework).toBe("jest");
    });
  });

  // ─── Edge cases ───────────────────────────────────────

  describe("edge cases", () => {
    it("should return null when no config exists anywhere", () => {
      writeFile(tmpDir, "src/app.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(path.join(tmpDir, "src", "app.spec.ts"), tmpDir);

      expect(result).toBeNull();
    });

    it("should find config in deeply nested structure", () => {
      writeFile(tmpDir, "vitest.config.ts", "export default {}");
      writeFile(tmpDir, "packages/core/src/lib/deep/nested/utils.spec.ts", "// test");

      const result = resolver.findClosestTestConfig(
        path.join(tmpDir, "packages", "core", "src", "lib", "deep", "nested", "utils.spec.ts"),
        tmpDir,
      );

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("vitest");
    });
  });

  // ─── findAllTestConfigs ───────────────────────────────

  describe("findAllTestConfigs", () => {
    it("should find all configs in the path", () => {
      writeFile(tmpDir, "vitest.workspace.ts", "export default []");
      writeFile(tmpDir, "apps/my-app/vitest.config.ts", "export default {}");
      writeFile(tmpDir, "apps/my-app/src/app.spec.ts", "// test");

      const results = resolver.findAllTestConfigs(path.join(tmpDir, "apps", "my-app", "src", "app.spec.ts"), tmpDir);

      expect(results.length).toBeGreaterThanOrEqual(2);
      const frameworks = results.map((r) => r.framework);
      expect(frameworks).toContain("vitest");
    });
  });

  // ─── detectFrameworkFromConfigPath ────────────────────

  describe("detectFrameworkFromConfigPath", () => {
    it("should detect vitest from vitest.config.ts", () => {
      expect(resolver.detectFrameworkFromConfigPath("/some/path/vitest.config.ts")).toBe("vitest");
    });

    it("should detect jest from jest.config.ts", () => {
      expect(resolver.detectFrameworkFromConfigPath("/some/path/jest.config.ts")).toBe("jest");
    });

    it("should detect jasmine from jasmine.json", () => {
      expect(resolver.detectFrameworkFromConfigPath("/some/path/jasmine.json")).toBe("jasmine");
    });

    it("should return null for unknown config", () => {
      expect(resolver.detectFrameworkFromConfigPath("/some/path/webpack.config.js")).toBeNull();
    });
  });
});
