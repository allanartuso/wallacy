// ============================================================
// SmartStartResolver — The absolute priority feature.
//
// Given a focused file in the editor, resolves the closest
// owning Nx project and infers everything needed to start
// the continuous test engine scoped to that project.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import Container, {Service} from "typedi";
import {NxProjectInfo, SmartStartResult, TestFrameworkName} from "../../shared-types";
import {TestConfigResolver} from "../config/test-config-resolver";
import {TsconfigResolver} from "../config/tsconfig-resolver";
import {FileToProjectMapper, UnownedFileError} from "../nx-resolver/file-mapper";
import {NxWorkspaceResolver} from "../nx-resolver/workspace-resolver";

// Known executor → framework mappings
const EXECUTOR_FRAMEWORK_MAP: Record<string, TestFrameworkName> = {
  "@nx/jest:jest": "jest",
  "@nrwl/jest:jest": "jest",
  "@nx/vite:test": "vitest",
  "@nrwl/vite:test": "vitest",
};

// Config file patterns to detect framework
const FRAMEWORK_CONFIG_PATTERNS: Array<{
  framework: TestFrameworkName;
  patterns: string[];
}> = [
  {
    framework: "jest",
    patterns: ["jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs", "jest.config.json"],
  },
  {
    framework: "vitest",
    patterns: [
      "vitest.config.ts",
      "vitest.config.js",
      "vitest.config.mjs",
      "vite.config.ts", // Vitest can be configured inside vite config
    ],
  },
  {
    framework: "jasmine",
    patterns: ["jasmine.json", ".jasmine.json", "spec/support/jasmine.json"],
  },
];

/**
 * Names of Nx targets which are likely to be test targets,
 * in order of preference.
 */
const TEST_TARGET_NAMES = ["test", "test:unit", "unit-test", "spec"];

@Service()
export class SmartStartResolver {
  private readonly fileMapper = Container.get(FileToProjectMapper);
  private readonly tsconfigResolver = Container.get(TsconfigResolver);
  private readonly testConfigResolver = Container.get(TestConfigResolver);
  private readonly workspaceResolver = Container.get(NxWorkspaceResolver);

  /**
   * Resolve the Smart Start result for a given file path.
   *
   * Algorithm:
   * 1. Map file → owning project(s), pick the closest (deepest root)
   * 2. Detect the test framework from the project's targets/config
   * 3. Resolve the test target name and config path
   * 4. Compute transitive dependents via the Nx project graph
   *
   * @param filePath Absolute path to the focused file
   * @param includeDependents Whether to compute dependents (default: true)
   */
  async resolve(filePath: string, includeDependents = true): Promise<SmartStartResult> {
    console.log(`[SmartStartResolver] Resolving: ${filePath}`);

    const workspaceRoot = this.workspaceResolver.getWorkspaceRoot();

    // Step 1: Map to closest project
    const projects = await this.fileMapper.mapFileToProjects(filePath);
    console.log(`[SmartStartResolver] Found ${projects.length} project(s) for file`);

    if (projects.length === 0) {
      throw new UnownedFileError(filePath);
    }

    const project = projects[0]; // closest by depth
    console.log(`[SmartStartResolver] Selected project: ${project.name} (root: ${project.root})`);

    // Step 2: Resolve closest tsconfig.json for path alias support
    const tsconfigInfo = await this.tsconfigResolver.findClosestTsconfig(filePath, workspaceRoot);
    const tsconfigPath = tsconfigInfo?.tsconfigPath ?? null;
    // Store resolved (absolute) path aliases so consumers can use them directly
    const pathAliases: Record<string, string[]> = {};
    if (tsconfigInfo) {
      for (const alias of tsconfigInfo.pathAliases) {
        pathAliases[alias.alias] = alias.paths;
      }
    }
    console.log(`[SmartStartResolver] tsconfig: ${tsconfigPath || "(none found)"}`);
    if (Object.keys(pathAliases).length > 0) {
      console.log(`[SmartStartResolver] Path aliases: ${Object.keys(pathAliases).join(", ")}`);
    }

    // Step 3: Resolve closest test config — use it to detect framework
    const testConfigInfo = this.testConfigResolver.findClosestTestConfig(filePath, workspaceRoot);

    // Step 4: Detect test framework (config file → executor → deps → fallback)
    let testFramework: TestFrameworkName;
    if (testConfigInfo) {
      testFramework = testConfigInfo.framework;
      console.log(`[SmartStartResolver] Framework from config file: ${testFramework} (${testConfigInfo.configPath})`);
    } else {
      testFramework = await this.detectFramework(project);
      console.log(`[SmartStartResolver] Framework from fallback detection: ${testFramework}`);
    }

    // Step 5: Resolve test target and config path
    const testTarget = this.resolveTestTarget(project);
    console.log(`[SmartStartResolver] Test target: ${testTarget}`);

    const configPath = testConfigInfo?.configPath ?? (await this.resolveConfigPath(project, testFramework));
    console.log(`[SmartStartResolver] Config path: ${configPath || "(none found)"}`);

    // Step 6: Compute transitive dependents
    let dependents: string[] = [];
    if (includeDependents) {
      dependents = await this.workspaceResolver.getTransitiveDependents(project.name);
      console.log(`[SmartStartResolver] Found ${dependents.length} dependents`);
    }

    console.log(`[SmartStartResolver] Resolution complete`);
    return {
      project,
      testFramework,
      testTarget,
      configPath,
      tsconfigPath,
      pathAliases,
      dependents,
    };
  }

  // ─── Framework Detection ──────────────────────────────────

  /**
   * Detect the test framework for a project.
   *
   * Precedence:
   * 1. Explicit executor in the test target (most reliable)
   * 2. Presence of config files in the project root
   * 3. Dependencies in the closest package.json
   *
   * Falls back to 'jest' as the most common Nx default.
   */
  async detectFramework(project: NxProjectInfo): Promise<TestFrameworkName> {
    // Strategy 1: Check executor in test target
    const fromExecutor = this.detectFromExecutor(project);
    if (fromExecutor) {
      return fromExecutor;
    }

    // Strategy 2: Check config files
    const fromConfig = await this.detectFromConfigFiles(project);
    if (fromConfig) {
      return fromConfig;
    }

    // Strategy 3: Check package.json devDependencies
    const fromDeps = await this.detectFromDependencies(project);
    if (fromDeps) {
      return fromDeps;
    }

    // Default fallback
    return "jest";
  }

  // ─── Private helpers ──────────────────────────────────────

  private detectFromExecutor(project: NxProjectInfo): TestFrameworkName | null {
    if (!project.targets) {
      return null;
    }

    for (const targetName of TEST_TARGET_NAMES) {
      const target = project.targets[targetName];
      if (target?.executor) {
        const framework = EXECUTOR_FRAMEWORK_MAP[target.executor];
        if (framework) {
          return framework;
        }
      }
    }

    // Also check all targets, not just known names
    try {
      for (const target of Object.values(project.targets)) {
        if (target?.executor) {
          const framework = EXECUTOR_FRAMEWORK_MAP[target.executor];
          if (framework) {
            return framework;
          }
        }
      }
    } catch (e) {
      // Ignore if targets is not iterable
      console.warn(`[SmartStartResolver] Error iterating targets for project ${project.name}:`, e);
    }

    return null;
  }

  private async detectFromConfigFiles(project: NxProjectInfo): Promise<TestFrameworkName | null> {
    const workspaceRoot = this.workspaceResolver.getWorkspaceRoot();
    const projectRoot = path.resolve(workspaceRoot, project.root);

    for (const {framework, patterns} of FRAMEWORK_CONFIG_PATTERNS) {
      for (const pattern of patterns) {
        const configPath = path.join(projectRoot, pattern);
        if (await this.fileExists(configPath)) {
          return framework;
        }
      }
    }

    return null;
  }

  private async detectFromDependencies(project: NxProjectInfo): Promise<TestFrameworkName | null> {
    const workspaceRoot = this.workspaceResolver.getWorkspaceRoot();

    // Check project-level package.json first, then workspace root
    const searchPaths = [
      path.join(workspaceRoot, project.root, "package.json"),
      path.join(workspaceRoot, "package.json"),
    ];

    for (const pkgPath of searchPaths) {
      const framework = await this.checkPackageJsonForFramework(pkgPath);
      if (framework) {
        return framework;
      }
    }

    return null;
  }

  private async checkPackageJsonForFramework(pkgPath: string): Promise<TestFrameworkName | null> {
    try {
      const raw = await fs.promises.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      // Check in order of specificity
      if (allDeps["vitest"]) {
        return "vitest";
      }
      if (allDeps["jest"] || allDeps["@jest/core"]) {
        return "jest";
      }
      if (allDeps["jasmine"] || allDeps["jasmine-core"]) {
        return "jasmine";
      }
    } catch {
      // File doesn't exist or is invalid JSON — skip
    }
    return null;
  }

  private resolveTestTarget(project: NxProjectInfo): string {
    // Return the first matching test target name
    for (const targetName of TEST_TARGET_NAMES) {
      if (project.targets[targetName]) {
        return targetName;
      }
    }
    // If no known name, return 'test' as default
    return "test";
  }

  private async resolveConfigPath(project: NxProjectInfo, framework: TestFrameworkName): Promise<string | null> {
    const workspaceRoot = this.workspaceResolver.getWorkspaceRoot();
    const projectRoot = path.resolve(workspaceRoot, project.root);

    // First check if the target specifies a config path in options
    const testTarget = this.resolveTestTarget(project);
    const target = project.targets[testTarget];
    if (target?.options) {
      const configOption =
        (target.options["configFile"] as string) ??
        (target.options["jestConfig"] as string) ??
        (target.options["config"] as string);
      if (configOption) {
        const resolved = path.resolve(workspaceRoot, configOption);
        if (await this.fileExists(resolved)) {
          return resolved;
        }
      }
    }

    // Fall back to scanning for config files
    const patterns = FRAMEWORK_CONFIG_PATTERNS.find((p) => p.framework === framework);
    if (patterns) {
      for (const pattern of patterns.patterns) {
        const configPath = path.join(projectRoot, pattern);
        if (await this.fileExists(configPath)) {
          return configPath;
        }
      }
    }

    return null;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
