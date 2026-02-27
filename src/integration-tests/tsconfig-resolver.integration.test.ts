/**
 * Integration tests for TsconfigResolver.
 *
 * Creates real file system fixtures to test tsconfig discovery,
 * parsing, extends chains, and path alias resolution.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {TsconfigResolver} from "../core-engine/config/tsconfig-resolver";

// ─── Helpers ────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wallacy-test-tsconfig-"));
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

describe("TsconfigResolver", () => {
  let resolver: TsconfigResolver;
  let tmpDir: string;

  beforeEach(() => {
    resolver = new TsconfigResolver();
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ─── Finding tsconfig ──────────────────────────────────

  describe("findClosestTsconfig", () => {
    it("should find tsconfig.json in the same directory as the file", async () => {
      writeFile(tmpDir, "src/app.spec.ts", "// test");
      writeFile(
        tmpDir,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {target: "ES2022"},
        }),
      );

      const result = await resolver.findClosestTsconfig(path.join(tmpDir, "src", "app.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(result!.tsconfigPath).toBe(path.join(tmpDir, "tsconfig.json"));
    });

    it("should find tsconfig.json by walking up directories", async () => {
      writeFile(tmpDir, "apps/my-app/src/deep/nested/test.spec.ts", "// test");
      writeFile(
        tmpDir,
        "apps/my-app/tsconfig.json",
        JSON.stringify({
          compilerOptions: {strict: true},
        }),
      );

      const result = await resolver.findClosestTsconfig(
        path.join(tmpDir, "apps", "my-app", "src", "deep", "nested", "test.spec.ts"),
        tmpDir,
      );

      expect(result).not.toBeNull();
      expect(result!.tsconfigPath).toBe(path.join(tmpDir, "apps", "my-app", "tsconfig.json"));
    });

    it("should prefer tsconfig.json over tsconfig.base.json at same level", async () => {
      writeFile(tmpDir, "src/test.spec.ts", "// test");
      writeFile(tmpDir, "tsconfig.json", JSON.stringify({compilerOptions: {}}));
      writeFile(tmpDir, "tsconfig.base.json", JSON.stringify({compilerOptions: {}}));

      const result = await resolver.findClosestTsconfig(path.join(tmpDir, "src", "test.spec.ts"), tmpDir);

      expect(result).not.toBeNull();
      expect(path.basename(result!.tsconfigPath)).toBe("tsconfig.json");
    });

    it("should return null when no tsconfig exists", async () => {
      writeFile(tmpDir, "src/test.spec.ts", "// test");

      const result = await resolver.findClosestTsconfig(path.join(tmpDir, "src", "test.spec.ts"), tmpDir);

      expect(result).toBeNull();
    });

    it("should not search above the stop boundary", async () => {
      // tsconfig is above stopAt — should NOT be found
      writeFile(tmpDir, "tsconfig.json", JSON.stringify({compilerOptions: {}}));
      const projectRoot = path.join(tmpDir, "apps", "my-app");
      writeFile(tmpDir, "apps/my-app/src/test.spec.ts", "// test");

      const result = await resolver.findClosestTsconfig(
        path.join(tmpDir, "apps", "my-app", "src", "test.spec.ts"),
        projectRoot,
      );

      // Should only find within projectRoot, and there's no tsconfig there
      expect(result).toBeNull();
    });
  });

  // ─── Parsing ──────────────────────────────────────────

  describe("parseTsconfig", () => {
    it("should parse compilerOptions.paths", async () => {
      const tsconfigPath = writeFile(
        tmpDir,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@shared/*": ["libs/shared/src/*"],
              "@utils": ["libs/utils/src/index.ts"],
            },
          },
        }),
      );

      const result = await resolver.parseTsconfig(tsconfigPath);

      expect(result.rawPaths).toEqual({
        "@shared/*": ["libs/shared/src/*"],
        "@utils": ["libs/utils/src/index.ts"],
      });
      expect(result.pathAliases).toHaveLength(2);
      expect(result.pathAliases[0].alias).toBe("@shared/*");
      expect(result.pathAliases[0].paths[0]).toBe(path.resolve(tmpDir, "libs/shared/src/*"));
    });

    it("should resolve baseUrl to absolute path", async () => {
      const tsconfigPath = writeFile(
        tmpDir,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: "./src",
          },
        }),
      );

      const result = await resolver.parseTsconfig(tsconfigPath);

      expect(result.baseUrl).toBe(path.resolve(tmpDir, "src"));
    });

    it("should handle tsconfig with comments", async () => {
      const tsconfigPath = writeFile(
        tmpDir,
        "tsconfig.json",
        `{
          // This is a comment
          "compilerOptions": {
            "target": "ES2022",
            /* Another comment */
            "baseUrl": ".",
            "paths": {
              "@app/*": ["src/*"],
            }
          }
        }`,
      );

      const result = await resolver.parseTsconfig(tsconfigPath);

      expect(result.rawPaths).toEqual({
        "@app/*": ["src/*"],
      });
      expect(result.baseUrl).toBe(tmpDir);
    });

    it("should return empty paths when none are defined", async () => {
      const tsconfigPath = writeFile(
        tmpDir,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {target: "ES2022"},
        }),
      );

      const result = await resolver.parseTsconfig(tsconfigPath);

      expect(result.rawPaths).toEqual({});
      expect(result.pathAliases).toHaveLength(0);
    });
  });

  // ─── Extends chains ───────────────────────────────────

  describe("extends chains", () => {
    it("should resolve paths from extended tsconfig", async () => {
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

      const childPath = writeFile(
        tmpDir,
        "apps/my-app/tsconfig.json",
        JSON.stringify({
          extends: "../../tsconfig.base.json",
          compilerOptions: {
            outDir: "./dist",
          },
        }),
      );

      const result = await resolver.parseTsconfig(childPath);

      expect(result.rawPaths).toEqual({
        "@shared/*": ["libs/shared/src/*"],
      });
      expect(result.extendsChain).toHaveLength(2);
      expect(result.extendsChain[0]).toBe(childPath);
      expect(result.extendsChain[1]).toBe(path.join(tmpDir, "tsconfig.base.json"));
    });

    it("should merge paths from child and parent (child wins)", async () => {
      writeFile(
        tmpDir,
        "tsconfig.base.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@shared/*": ["libs/shared/src/*"],
              "@utils/*": ["libs/utils/src/*"],
            },
          },
        }),
      );

      const childPath = writeFile(
        tmpDir,
        "apps/my-app/tsconfig.json",
        JSON.stringify({
          extends: "../../tsconfig.base.json",
          compilerOptions: {
            paths: {
              "@shared/*": ["src/overridden/*"],
            },
          },
        }),
      );

      const result = await resolver.parseTsconfig(childPath);

      // Child's @shared/* should win, parent's @utils/* should remain
      expect(result.rawPaths["@shared/*"]).toEqual(["src/overridden/*"]);
      expect(result.rawPaths["@utils/*"]).toEqual(["libs/utils/src/*"]);
    });

    it("should handle multi-level extends chain", async () => {
      writeFile(
        tmpDir,
        "tsconfig.root.json",
        JSON.stringify({
          compilerOptions: {
            target: "ES2020",
            baseUrl: ".",
            paths: {
              "@root/*": ["src/*"],
            },
          },
        }),
      );

      writeFile(
        tmpDir,
        "tsconfig.base.json",
        JSON.stringify({
          extends: "./tsconfig.root.json",
          compilerOptions: {
            strict: true,
          },
        }),
      );

      const leafPath = writeFile(
        tmpDir,
        "apps/my-app/tsconfig.json",
        JSON.stringify({
          extends: "../../tsconfig.base.json",
          compilerOptions: {},
        }),
      );

      const result = await resolver.parseTsconfig(leafPath);

      expect(result.extendsChain).toHaveLength(3);
      expect(result.rawPaths["@root/*"]).toEqual(["src/*"]);
    });
  });

  // ─── Module resolution with paths ─────────────────────

  describe("resolveModuleWithPaths", () => {
    it("should resolve wildcard alias", async () => {
      const tsconfigPath = writeFile(
        tmpDir,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@shared/*": ["libs/shared/src/*"],
            },
          },
        }),
      );

      const info = await resolver.parseTsconfig(tsconfigPath);
      const resolved = resolver.resolveModuleWithPaths("@shared/utils", info);

      expect(resolved).not.toBeNull();
      expect(resolved![0]).toBe(path.resolve(tmpDir, "libs/shared/src/utils"));
    });

    it("should resolve exact alias", async () => {
      const tsconfigPath = writeFile(
        tmpDir,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@env": ["src/environments/environment.ts"],
            },
          },
        }),
      );

      const info = await resolver.parseTsconfig(tsconfigPath);
      const resolved = resolver.resolveModuleWithPaths("@env", info);

      expect(resolved).not.toBeNull();
      expect(resolved![0]).toBe(path.resolve(tmpDir, "src/environments/environment.ts"));
    });

    it("should return null for non-matching specifier", async () => {
      const tsconfigPath = writeFile(
        tmpDir,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@shared/*": ["libs/shared/src/*"],
            },
          },
        }),
      );

      const info = await resolver.parseTsconfig(tsconfigPath);
      const resolved = resolver.resolveModuleWithPaths("lodash", info);

      expect(resolved).toBeNull();
    });
  });

  // ─── Nx monorepo layout ───────────────────────────────

  describe("Nx monorepo layout", () => {
    it("should resolve paths in a typical Nx workspace", async () => {
      // Workspace root tsconfig.base.json with path mappings
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
              "@myorg/utils": ["libs/utils/src/index.ts"],
            },
          },
        }),
      );

      // App-level tsconfig extending base
      const appTsconfig = writeFile(
        tmpDir,
        "apps/my-app/tsconfig.json",
        JSON.stringify({
          extends: "../../tsconfig.base.json",
          compilerOptions: {
            outDir: "../../dist/apps/my-app",
          },
        }),
      );

      writeFile(tmpDir, "apps/my-app/src/app.spec.ts", "// test");

      // Resolve from the test file
      const result = await resolver.findClosestTsconfig(
        path.join(tmpDir, "apps", "my-app", "src", "app.spec.ts"),
        tmpDir,
      );

      expect(result).not.toBeNull();
      expect(result!.tsconfigPath).toBe(appTsconfig);

      // Verify path aliases are inherited from base
      expect(result!.rawPaths["@myorg/shared"]).toEqual(["libs/shared/src/index.ts"]);
      expect(result!.rawPaths["@myorg/utils"]).toEqual(["libs/utils/src/index.ts"]);

      // Resolve a module
      const resolved = resolver.resolveModuleWithPaths("@myorg/shared/models", result!);
      expect(resolved).not.toBeNull();
    });
  });
});
