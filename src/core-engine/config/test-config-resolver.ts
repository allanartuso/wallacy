/**
 * TestConfigResolver — Finds the closest test framework config for a given file.
 *
 * Walks up the directory tree from the active file to find:
 * - vitest.config.ts / vitest.config.js / vitest.config.mjs
 * - vite.config.ts (can contain vitest config)
 * - jest.config.ts / jest.config.js / jest.config.cjs / jest.config.json
 * - jasmine.json / .jasmine.json / spec/support/jasmine.json
 * - vitest.workspace.ts / vitest.workspace.js (Nx monorepo pattern)
 *
 * Runs in the USER's workspace, not this repo.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {TestFrameworkName} from "../../shared-types";

// ─── Types ──────────────────────────────────────────────────

export interface TestConfigInfo {
  /** Absolute path to the test config file */
  configPath: string;
  /** Detected test framework from this config */
  framework: TestFrameworkName;
  /** The directory containing the config */
  configDir: string;
  /** Whether this is a workspace-level config (vitest.workspace.ts, etc.) */
  isWorkspaceConfig: boolean;
}

// ─── Config patterns in search priority order ───────────────

interface ConfigCandidate {
  filename: string;
  framework: TestFrameworkName;
  isWorkspaceConfig: boolean;
}

/**
 * Ordered by specificity: framework-specific configs first,
 * then more generic ones.
 */
const CONFIG_CANDIDATES: ConfigCandidate[] = [
  // Vitest — project-level
  {filename: "vitest.config.ts", framework: "vitest", isWorkspaceConfig: false},
  {filename: "vitest.config.js", framework: "vitest", isWorkspaceConfig: false},
  {filename: "vitest.config.mjs", framework: "vitest", isWorkspaceConfig: false},
  {filename: "vitest.config.mts", framework: "vitest", isWorkspaceConfig: false},
  // Jest — project-level
  {filename: "jest.config.ts", framework: "jest", isWorkspaceConfig: false},
  {filename: "jest.config.js", framework: "jest", isWorkspaceConfig: false},
  {filename: "jest.config.mjs", framework: "jest", isWorkspaceConfig: false},
  {filename: "jest.config.cjs", framework: "jest", isWorkspaceConfig: false},
  {filename: "jest.config.json", framework: "jest", isWorkspaceConfig: false},
  // Jasmine
  {filename: "jasmine.json", framework: "jasmine", isWorkspaceConfig: false},
  {filename: ".jasmine.json", framework: "jasmine", isWorkspaceConfig: false},
  // Vite (may contain vitest config via test property)
  {filename: "vite.config.ts", framework: "vitest", isWorkspaceConfig: false},
  {filename: "vite.config.js", framework: "vitest", isWorkspaceConfig: false},
  {filename: "vite.config.mts", framework: "vitest", isWorkspaceConfig: false},
  // Vitest workspace configs (monorepo-level)
  {filename: "vitest.workspace.ts", framework: "vitest", isWorkspaceConfig: true},
  {filename: "vitest.workspace.js", framework: "vitest", isWorkspaceConfig: true},
  {filename: "vitest.workspace.mts", framework: "vitest", isWorkspaceConfig: true},
  // Jest preset (workspace-level)
  {filename: "jest.preset.js", framework: "jest", isWorkspaceConfig: true},
  {filename: "jest.preset.ts", framework: "jest", isWorkspaceConfig: true},
];

import {Service} from "typedi";

// ─── TestConfigResolver ─────────────────────────────────────

@Service()
export class TestConfigResolver {
  /**
   * Find the closest test framework config by walking up from `startPath`.
   *
   * @param startPath Absolute path to the file or directory to start from
   * @param stopAt Absolute path to stop searching (workspace root)
   * @param preferredFramework Optional framework to prefer if multiple configs exist
   * @returns TestConfigInfo or null if no config found
   */
  findClosestTestConfig(
    startPath: string,
    stopAt: string,
    preferredFramework?: TestFrameworkName,
  ): TestConfigInfo | null {
    const startDir = this.isDirectory(startPath) ? startPath : path.dirname(startPath);

    // Phase 1: Walk up looking for project-level configs
    const projectConfig = this.walkUpForConfig(startDir, stopAt, preferredFramework, /* workspaceOnly */ false);
    if (projectConfig) {
      return projectConfig;
    }

    // Phase 2: Check workspace root for workspace-level configs
    const workspaceConfig = this.checkDirectoryForConfig(stopAt, preferredFramework, /* workspaceOnly */ true);
    if (workspaceConfig) {
      return workspaceConfig;
    }

    return null;
  }

  /**
   * Find ALL test configs in the directory chain (for diagnostics / multi-config scenarios).
   *
   * @param startPath Absolute path to the file or directory to start from
   * @param stopAt Absolute path to stop searching (workspace root)
   * @returns Array of TestConfigInfo, ordered from closest to farthest
   */
  findAllTestConfigs(startPath: string, stopAt: string): TestConfigInfo[] {
    const startDir = this.isDirectory(startPath) ? startPath : path.dirname(startPath);

    const results: TestConfigInfo[] = [];
    const normalizedStop = this.normalizePath(stopAt);
    let currentDir = startDir;
    let iterations = 0;
    const maxIterations = 30;

    while (iterations < maxIterations) {
      iterations++;

      const configs = this.getAllConfigsInDirectory(currentDir);
      results.push(...configs);

      if (this.normalizePath(currentDir) === normalizedStop) {
        break;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return results;
  }

  /**
   * Detect the framework from a given config file path (by filename).
   */
  detectFrameworkFromConfigPath(configPath: string): TestFrameworkName | null {
    const filename = path.basename(configPath);
    const candidate = CONFIG_CANDIDATES.find((c) => c.filename === filename);
    return candidate?.framework ?? null;
  }

  // ─── Private ──────────────────────────────────────────────

  private walkUpForConfig(
    startDir: string,
    stopAt: string,
    preferredFramework: TestFrameworkName | undefined,
    workspaceOnly: boolean,
  ): TestConfigInfo | null {
    const normalizedStop = this.normalizePath(stopAt);
    let currentDir = startDir;
    let iterations = 0;
    const maxIterations = 30;

    while (iterations < maxIterations) {
      iterations++;

      const found = this.checkDirectoryForConfig(currentDir, preferredFramework, workspaceOnly);
      if (found) {
        return found;
      }

      if (this.normalizePath(currentDir) === normalizedStop) {
        break;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return null;
  }

  private checkDirectoryForConfig(
    dir: string,
    preferredFramework: TestFrameworkName | undefined,
    workspaceOnly: boolean,
  ): TestConfigInfo | null {
    const candidates = CONFIG_CANDIDATES.filter((c) => workspaceOnly === c.isWorkspaceConfig);

    // If we have a preferred framework, check those first
    if (preferredFramework) {
      const preferred = candidates.filter((c) => c.framework === preferredFramework);
      for (const candidate of preferred) {
        const fullPath = path.join(dir, candidate.filename);
        if (this.fileExistsSync(fullPath)) {
          return {
            configPath: fullPath,
            framework: candidate.framework,
            configDir: dir,
            isWorkspaceConfig: candidate.isWorkspaceConfig,
          };
        }
      }
    }

    // Check all candidates
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate.filename);
      if (this.fileExistsSync(fullPath)) {
        return {
          configPath: fullPath,
          framework: candidate.framework,
          configDir: dir,
          isWorkspaceConfig: candidate.isWorkspaceConfig,
        };
      }
    }

    // Also check jasmine special path
    if (!workspaceOnly) {
      const jasmineSpecPath = path.join(dir, "spec", "support", "jasmine.json");
      if (this.fileExistsSync(jasmineSpecPath)) {
        return {
          configPath: jasmineSpecPath,
          framework: "jasmine",
          configDir: dir,
          isWorkspaceConfig: false,
        };
      }
    }

    return null;
  }

  private getAllConfigsInDirectory(dir: string): TestConfigInfo[] {
    const results: TestConfigInfo[] = [];

    for (const candidate of CONFIG_CANDIDATES) {
      const fullPath = path.join(dir, candidate.filename);
      if (this.fileExistsSync(fullPath)) {
        results.push({
          configPath: fullPath,
          framework: candidate.framework,
          configDir: dir,
          isWorkspaceConfig: candidate.isWorkspaceConfig,
        });
      }
    }

    return results;
  }

  private fileExistsSync(filePath: string): boolean {
    try {
      fs.accessSync(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private isDirectory(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").toLowerCase();
  }
}
