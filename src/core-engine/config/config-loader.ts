/**
 * ConfigLoader — Loads and merges continuous-test.config.js configuration.
 *
 * Supports:
 *   - Workspace-level config at workspace root
 *   - Per-project overrides inside each project root
 *   - Deep merging of options with project-level taking precedence
 */

import * as path from 'path';
import * as fs from 'fs';

// ─── Configuration Types ───────────────────────────────────

export interface InstrumentationConfig {
    lineCoverage?: boolean;
    branchCoverage?: boolean;
    valueCapture?: boolean;
    importTracing?: boolean;
    functionTracing?: boolean;
}

export interface DebugConfig {
    enableTracing?: boolean;
    traceBufferSize?: number;
    snapshotCapture?: boolean;
}

export interface ContinuousTestConfig {
    /** Which test framework to use (auto-detected if not set) */
    testFramework?: 'jest' | 'vitest' | 'jasmine';
    /** Enable/disable watch mode (default: true) */
    watchMode?: boolean;
    /** Instrumentation options */
    instrumentation?: InstrumentationConfig;
    /** Debugging options */
    debug?: DebugConfig;
    /** Glob patterns to exclude from watching/instrumentation */
    exclude?: string[];
    /** Glob patterns to include (overrides default file extensions) */
    include?: string[];
    /** Maximum number of parallel workers */
    maxWorkers?: number;
    /** Debounce delay in ms for file change reactions */
    debounceMs?: number;
    /** Per-project configuration overrides (keyed by project name) */
    projects?: Record<string, Partial<Omit<ContinuousTestConfig, 'projects'>>>;
}

// ─── Default Configuration ──────────────────────────────────

export const DEFAULT_CONFIG: Required<Omit<ContinuousTestConfig, 'projects'>> & { projects: Record<string, Partial<ContinuousTestConfig>> } = {
    testFramework: 'vitest',
    watchMode: true,
    instrumentation: {
        lineCoverage: true,
        branchCoverage: true,
        valueCapture: false,
        importTracing: false,
        functionTracing: true,
    },
    debug: {
        enableTracing: true,
        traceBufferSize: 10_000,
        snapshotCapture: true,
    },
    exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        '**/.git/**',
    ],
    include: [
        '**/*.ts',
        '**/*.tsx',
        '**/*.js',
        '**/*.jsx',
    ],
    maxWorkers: 4,
    debounceMs: 150,
    projects: {},
};

const CONFIG_FILENAMES = [
    'continuous-test.config.js',
    'continuous-test.config.mjs',
    'continuous-test.config.cjs',
    'continuous-test.config.ts',
];

// ─── ConfigLoader Class ────────────────────────────────────

export class ConfigLoader {
    private workspaceRoot: string;
    private cachedConfig: ContinuousTestConfig | null = null;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    /**
     * Load the workspace-level configuration.
     * Returns a merged config (defaults + workspace config file).
     */
    async loadWorkspaceConfig(): Promise<ContinuousTestConfig> {
        if (this.cachedConfig) {
            return this.cachedConfig;
        }

        const configPath = this.findConfigFile(this.workspaceRoot);
        let userConfig: Partial<ContinuousTestConfig> = {};

        if (configPath) {
            userConfig = await this.loadConfigFile(configPath);
        }

        this.cachedConfig = this.deepMerge(DEFAULT_CONFIG, userConfig);
        return this.cachedConfig;
    }

    /**
     * Load the effective configuration for a specific project.
     * Merges: defaults → workspace config → per-project overrides → project-local config file.
     */
    async loadProjectConfig(projectName: string, projectRoot: string): Promise<ContinuousTestConfig> {
        const workspaceConfig = await this.loadWorkspaceConfig();

        // Start with the workspace config
        let projectConfig: ContinuousTestConfig = { ...workspaceConfig };

        // Apply per-project overrides from the workspace config
        const overrides = workspaceConfig.projects?.[projectName];
        if (overrides) {
            projectConfig = this.deepMerge(projectConfig, overrides);
        }

        // Check for a project-local config file
        const absoluteProjectRoot = path.resolve(this.workspaceRoot, projectRoot);
        const localConfigPath = this.findConfigFile(absoluteProjectRoot);

        if (localConfigPath) {
            const localConfig = await this.loadConfigFile(localConfigPath);
            projectConfig = this.deepMerge(projectConfig, localConfig);
        }

        // Remove the projects key from the final per-project config
        delete projectConfig.projects;
        return projectConfig;
    }

    /**
     * Force cache invalidation (e.g., when the config file changes).
     */
    invalidateCache(): void {
        this.cachedConfig = null;
    }

    // ─── Private Helpers ──────────────────────────────────────

    private findConfigFile(directory: string): string | null {
        for (const filename of CONFIG_FILENAMES) {
            const fullPath = path.join(directory, filename);
            if (fs.existsSync(fullPath)) {
                return fullPath;
            }
        }
        return null;
    }

    private async loadConfigFile(configPath: string): Promise<Partial<ContinuousTestConfig>> {
        try {
            // Clear require cache for hot reload
            delete require.cache[require.resolve(configPath)];
            const loaded = require(configPath);
            // Handle both default export and module.exports
            return loaded.default ?? loaded;
        } catch (error) {
            console.warn(`[ConfigLoader] Failed to load config at ${configPath}:`, error);
            return {};
        }
    }

    /**
     * Deep merge two config objects. Source values override target values.
     * Arrays are replaced (not merged).
     */
    private deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
        const output = { ...target };

        for (const key of Object.keys(source) as Array<keyof T>) {
            const sourceVal = source[key];
            const targetVal = target[key];

            if (
                sourceVal !== undefined &&
                sourceVal !== null &&
                typeof sourceVal === 'object' &&
                !Array.isArray(sourceVal) &&
                targetVal !== undefined &&
                typeof targetVal === 'object' &&
                !Array.isArray(targetVal)
            ) {
                (output as any)[key] = this.deepMerge(
                    targetVal as Record<string, any>,
                    sourceVal as Record<string, any>,
                );
            } else if (sourceVal !== undefined) {
                (output as any)[key] = sourceVal;
            }
        }

        return output;
    }
}
