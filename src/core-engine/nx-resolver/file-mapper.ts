// ============================================================
// FileToProjectMapper — Maps any file path to its owning
// Nx project(s), ordered by proximity (deepest root first).
// Falls back to file-system discovery for non-Nx projects.
// ============================================================

import * as fs from "node:fs/promises";
import * as path from "node:path";
import Container, {Service} from "typedi";
import {NxProjectInfo} from "../../shared-types";
import {NxWorkspaceResolver} from "./workspace-resolver";

export class UnownedFileError extends Error {
  constructor(public readonly filePath: string) {
    super(`File "${filePath}" does not belong to any Nx project in the workspace.`);
    this.name = "UnownedFileError";
  }
}

@Service()
export class FileToProjectMapper {
  readonly workspaceResolver: NxWorkspaceResolver = Container.get(NxWorkspaceResolver);

  /**
   * Map a file path to its owning Nx project(s).
   *
   * Algorithm:
   * 1. If this is an Nx workspace, use Nx project graph
   * 2. Otherwise, discover project from file system (config files, package.json)
   * 3. Walk up directory tree from file to find project root
   *
   * @returns NxProjectInfo[] ordered by proximity (closest first).
   */
  async mapFileToProjects(absoluteFilePath: string): Promise<NxProjectInfo[]> {
    const workspaceRoot = this.workspaceResolver.getWorkspaceRoot();

    // Try Nx first - check if workspace.json or nx.json exists
    const isNxWorkspace = await this.isNxWorkspace(workspaceRoot);
    console.log(`[FileToProjectMapper] Checking if Nx workspace: ${isNxWorkspace}`);

    if (isNxWorkspace) {
      const nxProjects = await this.mapFileToProjectsNx(absoluteFilePath, workspaceRoot);
      // If Nx graph found projects, use them
      if (nxProjects.length > 0) {
        return nxProjects;
      }
      // If Nx graph is empty (e.g. @nx/devkit not available), fall back to file-system discovery
      console.log(`[FileToProjectMapper] Nx graph returned no projects, falling back to file-system discovery`);
    }

    // Non-Nx workspace or empty Nx graph: discover project from file system
    return this.discoverProjectFromFileSystem(absoluteFilePath, workspaceRoot);
  }

  /**
   * Use Nx project graph to map file to projects
   */
  private async mapFileToProjectsNx(absoluteFilePath: string, workspaceRoot: string): Promise<NxProjectInfo[]> {
    const relativePath = this.normalizeToRelative(absoluteFilePath, workspaceRoot);

    const allProjects = await this.workspaceResolver.getAllProjects();
    const matchingProjects: NxProjectInfo[] = [];

    for (const project of allProjects) {
      const projectRoot = this.normalizePath(project.root);
      if (this.isUnderDirectory(relativePath, projectRoot)) {
        matchingProjects.push(project);
      }
    }

    // Sort by depth descending — deepest (closest) project root first
    matchingProjects.sort((a, b) => {
      const depthA = this.getPathDepth(a.root);
      const depthB = this.getPathDepth(b.root);
      return depthB - depthA;
    });

    return matchingProjects;
  }

  /**
   * For non-Nx workspaces: discover project by walking up directory tree
   * looking for package.json and test config files
   */
  private async discoverProjectFromFileSystem(
    absoluteFilePath: string,
    workspaceRoot: string,
  ): Promise<NxProjectInfo[]> {
    console.log(`[FileToProjectMapper] Discovering project from file system for: ${path.basename(absoluteFilePath)}`);

    // Walk up from file location to find project root (where package.json is)
    const projectRoot = await this.findProjectRoot(absoluteFilePath, workspaceRoot);

    if (!projectRoot) {
      console.log(`[FileToProjectMapper] Could not find project root`);
      return [];
    }

    console.log(`[FileToProjectMapper] Found project root: ${projectRoot}`);

    // Create synthetic project based on discovered file system structure
    const syntheticProject: NxProjectInfo = {
      name: path.basename(projectRoot) || "workspace-root",
      root: projectRoot,
      sourceRoot: projectRoot,
      targets: {},
      tags: [],
      implicitDependencies: [],
      projectType: "application",
    };

    return [syntheticProject];
  }

  /**
   * Walk up directory tree to find project root
   * Look for: package.json, vitest.config.*, jest.config.*, tsconfig.json
   */
  private async findProjectRoot(filePath: string, workspaceRoot: string): Promise<string | null> {
    let currentDir = path.dirname(filePath);
    const maxIterations = 20; // Avoid infinite loops
    let iterations = 0;

    while (currentDir.startsWith(workspaceRoot) && iterations < maxIterations) {
      iterations++;

      // Check for package.json (strong indicator of project root)
      if (await this.fileExists(path.join(currentDir, "package.json"))) {
        console.log(`[FileToProjectMapper] Found package.json at: ${currentDir}`);
        return currentDir;
      }

      // Check for test config files
      const configFiles = [
        "vitest.config.ts",
        "vitest.config.js",
        "vitest.config.mjs",
        "vite.config.ts",
        "jest.config.ts",
        "jest.config.js",
        "jest.config.json",
        "tsconfig.json",
      ];

      for (const configFile of configFiles) {
        if (await this.fileExists(path.join(currentDir, configFile))) {
          console.log(`[FileToProjectMapper] Found ${configFile} at: ${currentDir}`);
          return currentDir;
        }
      }

      // Move up one directory
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        // Reached root of file system
        break;
      }
      currentDir = parentDir;
    }

    // Fallback: return workspace root as project root
    console.log(`[FileToProjectMapper] Falling back to workspace root: ${workspaceRoot}`);
    return workspaceRoot;
  }

  /**
   * Check if workspace root contains Nx config
   */
  private async isNxWorkspace(workspaceRoot: string): Promise<boolean> {
    // Check for workspace.json or nx.json
    const nxConfigFiles = ["workspace.json", "nx.json"];

    for (const configFile of nxConfigFiles) {
      if (await this.fileExists(path.join(workspaceRoot, configFile))) {
        console.log(`[FileToProjectMapper] Found Nx config: ${configFile}`);
        return true;
      }
    }

    return false;
  }

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Convenience: maps a file and throws if unowned.
   */
  async mapFileToProjectOrThrow(absoluteFilePath: string): Promise<NxProjectInfo> {
    const projects = await this.mapFileToProjects(absoluteFilePath);
    if (projects.length === 0) {
      throw new UnownedFileError(absoluteFilePath);
    }
    return projects[0];
  }

  /**
   * Get all projects affected by changes to a set of files.
   * Returns unique projects.
   */
  async getAffectedProjects(absoluteFilePaths: string[]): Promise<NxProjectInfo[]> {
    const projectMap = new Map<string, NxProjectInfo>();
    for (const filePath of absoluteFilePaths) {
      const projects = await this.mapFileToProjects(filePath);
      for (const project of projects) {
        if (!projectMap.has(project.name)) {
          projectMap.set(project.name, project);
        }
      }
    }
    return Array.from(projectMap.values());
  }

  // ─── Private helpers ──────────────────────────────────────

  private normalizeToRelative(absolutePath: string, workspaceRoot: string): string {
    const normalized = this.normalizePath(absolutePath);
    const normalizedRoot = this.normalizePath(workspaceRoot);

    if (normalized.startsWith(normalizedRoot)) {
      let relative = normalized.slice(normalizedRoot.length);
      if (relative.startsWith("/")) {
        relative = relative.slice(1);
      }
      return relative;
    }

    // If already relative or different drive, try path.relative
    return this.normalizePath(path.relative(workspaceRoot, absolutePath));
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  private isUnderDirectory(filePath: string, dirPath: string): boolean {
    if (dirPath === "" || dirPath === ".") {
      return true;
    }
    return filePath.startsWith(dirPath + "/") || filePath === dirPath;
  }

  private getPathDepth(p: string): number {
    if (p === "" || p === ".") {
      return 0;
    }
    return p.split("/").filter(Boolean).length;
  }
}
