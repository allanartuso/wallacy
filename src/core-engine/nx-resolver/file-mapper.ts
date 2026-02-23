// ============================================================
// FileToProjectMapper — Maps any file path to its owning
// Nx project(s), ordered by proximity (deepest root first).
// ============================================================

import * as path from "node:path";
import type { NxWorkspaceResolver } from "./workspace-resolver";
import { NxProjectInfo } from "../../shared-types";

export class UnownedFileError extends Error {
  constructor(public readonly filePath: string) {
    super(
      `File "${filePath}" does not belong to any Nx project in the workspace.`,
    );
    this.name = "UnownedFileError";
  }
}

export class FileToProjectMapper {
  constructor(public readonly workspaceResolver: NxWorkspaceResolver) {}

  /**
   * Map a file path to its owning Nx project(s).
   *
   * Algorithm:
   * 1. Normalize the path relative to workspace root
   * 2. For each project, check if the file is under project.root
   * 3. If multiple matches (nested projects), sort by descending depth
   *    (deepest/closest project root wins, first element)
   *
   * @returns NxProjectInfo[] ordered by proximity (closest first). Empty if unowned.
   */
  async mapFileToProjects(absoluteFilePath: string): Promise<NxProjectInfo[]> {
    const workspaceRoot = this.workspaceResolver.getWorkspaceRoot();
    const relativePath = this.normalizeToRelative(
      absoluteFilePath,
      workspaceRoot,
    );

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
   * Convenience: maps a file and throws if unowned.
   */
  async mapFileToProjectOrThrow(
    absoluteFilePath: string,
  ): Promise<NxProjectInfo> {
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
  async getAffectedProjects(
    absoluteFilePaths: string[],
  ): Promise<NxProjectInfo[]> {
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

  private normalizeToRelative(
    absolutePath: string,
    workspaceRoot: string,
  ): string {
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
    if (dirPath === "" || dirPath === ".") return true;
    return filePath.startsWith(dirPath + "/") || filePath === dirPath;
  }

  private getPathDepth(p: string): number {
    if (p === "" || p === ".") return 0;
    return p.split("/").filter(Boolean).length;
  }
}
