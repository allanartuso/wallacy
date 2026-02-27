// ============================================================
// NxWorkspaceResolver — Detects workspace root, loads and
// caches the Nx project graph using official @nx/devkit APIs.
// ============================================================

import Container, {Service} from "typedi";
import {NxProjectInfo, TargetConfiguration} from "../../shared-types";
import {VsCodeService} from "../../vs-code.service";

// ─── Types for the Nx devkit API surface we consume ─────────

/**
 * Minimal subset of Nx's ProjectGraphProjectNode.
 * We define this to decouple from Nx's internal types and
 * allow easy mocking in tests.
 */
export interface NxProjectGraphNode {
  name: string;
  type: "app" | "lib" | "e2e";
  data: {
    root: string;
    sourceRoot?: string;
    targets?: Record<
      string,
      {
        executor?: string;
        options?: Record<string, unknown>;
        configurations?: Record<string, Record<string, unknown>>;
      }
    >;
    tags?: string[];
    implicitDependencies?: string[];
    projectType?: "application" | "library";
  };
}

export interface NxProjectGraphDependency {
  source: string;
  target: string;
  type: "static" | "dynamic" | "implicit";
}

export interface NxProjectGraph {
  nodes: Record<string, NxProjectGraphNode>;
  dependencies: Record<string, NxProjectGraphDependency[]>;
}

/**
 * Abstraction over Nx devkit functions so we can inject mocks.
 */
export interface NxDevkitBridge {
  createProjectGraphAsync(workspaceRoot: string): Promise<NxProjectGraph>;
}

// ─── Default bridge using real @nx/devkit ───────────────────

export const createDefaultDevkitBridge = (): NxDevkitBridge => ({
  async createProjectGraphAsync(workspaceRoot: string): Promise<NxProjectGraph> {
    // Try to load Nx project graph ONLY if this is actually an Nx workspace
    // For non-Nx workspaces, return empty graph and let FileToProjectMapper
    // discover projects from file system instead
    try {
      // Dynamic require to avoid hard dependency on @nx/devkit at compile time
      const {createProjectGraphAsync: createGraph} = require("@nx/devkit");
      process.chdir(workspaceRoot);
      const graph = await createGraph({exitOnError: false});
      console.log(
        `[NxWorkspaceResolver] Loaded Nx project graph with ${Object.keys(graph.nodes || {}).length} projects`,
      );
      return graph as NxProjectGraph;
    } catch (error: any) {
      console.log(`[NxWorkspaceResolver] Not an Nx workspace - will use file system discovery: ${error?.message}`);
      // Return empty graph - let FileToProjectMapper handle file system discovery
      return {nodes: {}, dependencies: {}};
    }
  },
});

// ─── NxWorkspaceResolver ────────────────────────────────────

@Service()
export class NxWorkspaceResolver {
  private readonly vsCodeService = Container.get(VsCodeService);
  private cachedGraph: NxProjectGraph | null = null;
  private cachedProjects: Map<string, NxProjectInfo> = new Map();
  private cacheTimestamp = 0;
  private readonly devkit: NxDevkitBridge = createDefaultDevkitBridge();
  private readonly cacheTtlMs: number = 30_000;

  getWorkspaceRoot(): string {
    const editor = this.vsCodeService.activeTextEditor;
    if (!editor) {
      this.vsCodeService.showErrorMessage("No active editor found");
      throw new Error("No active editor found");
    }

    const workspaceFolder = this.vsCodeService.getWorkspaceFolder(editor.document.uri);

    this.vsCodeService.appendLine("[Extension] Smart Start initiated for: " + editor.document.uri.fsPath);

    if (!workspaceFolder) {
      this.vsCodeService.showErrorMessage("File is not part of a workspace");
      throw new Error("File is not part of a workspace");
    }

    return workspaceFolder.uri.fsPath;
  }

  /**
   * Load (or return cached) the Nx project graph.
   * Cache is invalidated after `cacheTtlMs`.
   */
  async getProjectGraph(): Promise<NxProjectGraph> {
    const now = Date.now();
    if (this.cachedGraph && now - this.cacheTimestamp < this.cacheTtlMs) {
      return this.cachedGraph;
    }
    this.cachedGraph = await this.devkit.createProjectGraphAsync(this.getWorkspaceRoot());
    this.cacheTimestamp = now;
    this.rebuildProjectMap();
    return this.cachedGraph;
  }

  /**
   * Get all projects as NxProjectInfo[].
   */
  async getAllProjects(): Promise<NxProjectInfo[]> {
    await this.getProjectGraph();
    return Array.from(this.cachedProjects.values());
  }

  /**
   * Get a single project by name.
   */
  async getProjectByName(name: string): Promise<NxProjectInfo | undefined> {
    await this.getProjectGraph();
    return this.cachedProjects.get(name);
  }

  /**
   * Get the direct dependencies of a project.
   */
  async getProjectDependencies(projectName: string): Promise<string[]> {
    const graph = await this.getProjectGraph();
    const deps = graph.dependencies[projectName] ?? [];
    return deps.map((d) => d.target);
  }

  /**
   * Get all projects that (transitively) depend on the given project.
   * Uses BFS over the reverse dependency graph.
   */
  async getTransitiveDependents(projectName: string): Promise<string[]> {
    const graph = await this.getProjectGraph();

    // Build reverse adjacency: target → sources that depend on it
    const reverseDeps = new Map<string, Set<string>>();
    for (const [source, deps] of Object.entries(graph.dependencies)) {
      for (const dep of deps) {
        if (!reverseDeps.has(dep.target)) {
          reverseDeps.set(dep.target, new Set());
        }
        reverseDeps.get(dep.target)!.add(source);
      }
    }

    // BFS from projectName
    const visited = new Set<string>();
    const queue: string[] = [projectName];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = reverseDeps.get(current);
      if (!dependents) {
        continue;
      }
      for (const dep of dependents) {
        if (!visited.has(dep) && dep !== projectName) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }

    return Array.from(visited);
  }

  /**
   * Force cache invalidation (e.g., when nx.json changes).
   */
  invalidateCache(): void {
    this.cachedGraph = null;
    this.cachedProjects.clear();
    this.cacheTimestamp = 0;
  }

  // ─── Private ────────────────────────────────────────────

  private rebuildProjectMap(): void {
    this.cachedProjects.clear();
    if (!this.cachedGraph) {
      return;
    }

    for (const [name, node] of Object.entries(this.cachedGraph.nodes)) {
      const targets: Record<string, TargetConfiguration> = {};
      if (node.data.targets) {
        for (const [tName, tConfig] of Object.entries(node.data.targets)) {
          targets[tName] = {
            executor: tConfig.executor,
            options: tConfig.options,
            configurations: tConfig.configurations,
          };
        }
      }

      this.cachedProjects.set(name, {
        name,
        root: node.data.root,
        sourceRoot: node.data.sourceRoot ?? node.data.root,
        targets,
        tags: node.data.tags ?? [],
        implicitDependencies: node.data.implicitDependencies ?? [],
        projectType: node.data.projectType,
      });
    }
  }
}
