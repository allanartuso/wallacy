/**
 * TsconfigResolver — Finds and parses the closest tsconfig.json for a given file.
 *
 * Responsibilities:
 * - Walk up directory tree from a file to find the nearest tsconfig.json
 * - Parse compilerOptions.paths and baseUrl
 * - Handle "extends" chains (tsconfig can extend another tsconfig)
 * - Return a TsconfigInfo object with resolved path aliases
 *
 * Runs in the USER's workspace, not this repo.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ──────────────────────────────────────────────────

export interface PathAlias {
  /** The alias pattern, e.g. "@shared/*" */
  alias: string;
  /** The resolved absolute paths this alias maps to */
  paths: string[];
}

export interface TsconfigInfo {
  /** Absolute path to the tsconfig.json file found */
  tsconfigPath: string;
  /** The directory containing the tsconfig.json */
  configDir: string;
  /** The baseUrl resolved to an absolute path (or null) */
  baseUrl: string | null;
  /** Resolved path aliases from compilerOptions.paths */
  pathAliases: PathAlias[];
  /** Raw compilerOptions.paths (before resolution) */
  rawPaths: Record<string, string[]>;
  /** Chain of extended tsconfig files (ordered: child → parent) */
  extendsChain: string[];
}

// ─── Tsconfig names in priority order ───────────────────────

const TSCONFIG_NAMES = [
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.lib.json",
  "tsconfig.spec.json",
  "tsconfig.base.json",
];

import {Service} from "typedi";

// ─── TsconfigResolver ──────────────────────────────────────

@Service()
export class TsconfigResolver {
  /**
   * Find the closest tsconfig.json by walking up from `startPath`.
   * Stops at `stopAt` (workspace root).
   *
   * @param startPath Absolute path to the file or directory to start from
   * @param stopAt Absolute path to stop searching (workspace root)
   * @returns TsconfigInfo or null if no tsconfig.json found
   */
  async findClosestTsconfig(startPath: string, stopAt: string): Promise<TsconfigInfo | null> {
    const startDir = this.isDirectory(startPath) ? startPath : path.dirname(startPath);

    const tsconfigPath = this.walkUpForTsconfig(startDir, stopAt);
    if (!tsconfigPath) {
      return null;
    }

    return this.parseTsconfig(tsconfigPath);
  }

  /**
   * Parse a tsconfig.json file and resolve its path aliases,
   * following the "extends" chain.
   *
   * @param tsconfigPath Absolute path to the tsconfig.json
   * @returns TsconfigInfo with resolved aliases
   */
  async parseTsconfig(tsconfigPath: string): Promise<TsconfigInfo> {
    const extendsChain: string[] = [];
    const mergedCompilerOptions = this.resolveExtendsChain(tsconfigPath, extendsChain);

    const configDir = path.dirname(tsconfigPath);

    // Resolve baseUrl relative to the tsconfig that declares it
    const rawBaseUrl = mergedCompilerOptions.baseUrl;
    const baseUrl = rawBaseUrl ? path.resolve(configDir, rawBaseUrl) : null;

    // Resolve paths
    const rawPaths: Record<string, string[]> = mergedCompilerOptions.paths ?? {};
    const pathAliases = this.resolvePathAliases(rawPaths, baseUrl ?? configDir);

    return {
      tsconfigPath,
      configDir,
      baseUrl,
      pathAliases,
      rawPaths,
      extendsChain,
    };
  }

  /**
   * Resolve a module specifier using tsconfig path aliases.
   * Returns the resolved absolute path(s), or null if no alias matched.
   *
   * @param specifier The import specifier (e.g. "@shared/utils")
   * @param tsconfigInfo Parsed tsconfig info
   * @returns Array of possible resolved paths, or null
   */
  resolveModuleWithPaths(specifier: string, tsconfigInfo: TsconfigInfo): string[] | null {
    for (const alias of tsconfigInfo.pathAliases) {
      const match = this.matchAlias(specifier, alias.alias);
      if (match !== null) {
        return alias.paths.map((p) => p.replace("*", match));
      }
    }
    return null;
  }

  // ─── Private ──────────────────────────────────────────────

  /**
   * Walk up directories looking for a tsconfig file.
   */
  private walkUpForTsconfig(startDir: string, stopAt: string): string | null {
    const normalizedStop = this.normalizePath(stopAt);
    let currentDir = startDir;
    let iterations = 0;
    const maxIterations = 30;

    while (iterations < maxIterations) {
      iterations++;

      // Check each candidate name in priority order
      for (const name of TSCONFIG_NAMES) {
        const candidate = path.join(currentDir, name);
        if (this.fileExistsSync(candidate)) {
          return candidate;
        }
      }

      // If we've reached or passed the stop boundary, stop
      if (
        this.normalizePath(currentDir) === normalizedStop ||
        this.normalizePath(currentDir).length < normalizedStop.length
      ) {
        break;
      }

      // Move up
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // filesystem root
      }
      currentDir = parentDir;
    }

    // One final check at the stopAt directory itself
    for (const name of TSCONFIG_NAMES) {
      const candidate = path.join(stopAt, name);
      if (this.fileExistsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Follow the "extends" chain and merge compilerOptions bottom-up.
   * Child values override parent values. Paths are merged (child wins).
   */
  private resolveExtendsChain(tsconfigPath: string, chain: string[], visited = new Set<string>()): Record<string, any> {
    const normalized = this.normalizePath(tsconfigPath);
    if (visited.has(normalized)) {
      return {}; // circular extends
    }
    visited.add(normalized);
    chain.push(tsconfigPath);

    const content = this.readJsonWithComments(tsconfigPath);
    if (!content) {
      return {};
    }

    let parentOptions: Record<string, any> = {};
    if (content.extends) {
      const extendsPath = this.resolveExtendsPath(content.extends, path.dirname(tsconfigPath));
      if (extendsPath) {
        parentOptions = this.resolveExtendsChain(extendsPath, chain, visited);
      }
    }

    // Merge: parent first, then child overrides
    const childOptions = content.compilerOptions ?? {};
    const merged = {...parentOptions, ...childOptions};

    // Special handling for paths: merge rather than replace
    if (parentOptions.paths && childOptions.paths) {
      merged.paths = {...parentOptions.paths, ...childOptions.paths};
    }

    return merged;
  }

  /**
   * Resolve the "extends" value to an absolute path.
   * Handles:
   *   - Relative paths: "./tsconfig.base.json"
   *   - Package references: "@nx/jest/tsconfig" (look in node_modules)
   */
  private resolveExtendsPath(extendsValue: string, fromDir: string): string | null {
    // Relative path
    if (extendsValue.startsWith(".") || extendsValue.startsWith("/")) {
      const resolved = path.resolve(fromDir, extendsValue);
      // Try with and without .json extension
      if (this.fileExistsSync(resolved)) {
        return resolved;
      }
      if (this.fileExistsSync(resolved + ".json")) {
        return resolved + ".json";
      }
      return null;
    }

    // Node module reference — look in node_modules
    const candidates = [
      path.join(fromDir, "node_modules", extendsValue),
      path.join(fromDir, "node_modules", extendsValue + ".json"),
      path.join(fromDir, "node_modules", extendsValue, "tsconfig.json"),
    ];

    // Also walk up to find node_modules
    let dir = fromDir;
    for (let i = 0; i < 10; i++) {
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
      candidates.push(path.join(dir, "node_modules", extendsValue));
      candidates.push(path.join(dir, "node_modules", extendsValue + ".json"));
      candidates.push(path.join(dir, "node_modules", extendsValue, "tsconfig.json"));
    }

    for (const candidate of candidates) {
      if (this.fileExistsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Convert raw paths entries to resolved PathAlias objects.
   */
  private resolvePathAliases(rawPaths: Record<string, string[]>, baseDir: string): PathAlias[] {
    const aliases: PathAlias[] = [];

    for (const [alias, mappings] of Object.entries(rawPaths)) {
      const resolvedPaths = mappings.map((m) => path.resolve(baseDir, m));
      aliases.push({alias, paths: resolvedPaths});
    }

    return aliases;
  }

  /**
   * Match a module specifier against a tsconfig paths alias pattern.
   * Returns the wildcard match or null.
   *
   * Examples:
   *   matchAlias("@shared/utils", "@shared/*") → "utils"
   *   matchAlias("@shared", "@shared") → ""
   *   matchAlias("lodash", "@shared/*") → null
   */
  private matchAlias(specifier: string, aliasPattern: string): string | null {
    if (aliasPattern.endsWith("/*")) {
      const prefix = aliasPattern.slice(0, -1); // "@shared/"
      if (specifier.startsWith(prefix)) {
        return specifier.slice(prefix.length);
      }
      // Also match exact (without trailing)
      const exactPrefix = aliasPattern.slice(0, -2); // "@shared"
      if (specifier === exactPrefix) {
        return "";
      }
      return null;
    }

    // Exact match (no wildcard)
    if (specifier === aliasPattern) {
      return "";
    }

    return null;
  }

  /**
   * Read a JSON file that may contain comments (tsconfig supports // and /* *\/ comments).
   */
  private readJsonWithComments(filePath: string): any | null {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      // Strip single-line comments
      const stripped = raw
        .replace(/\/\/.*$/gm, "")
        // Strip multi-line comments
        .replace(/\/\*[\s\S]*?\*\//g, "")
        // Remove trailing commas before } or ]
        .replace(/,\s*([\]}])/g, "$1");
      return JSON.parse(stripped);
    } catch {
      return null;
    }
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
