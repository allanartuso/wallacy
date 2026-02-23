// ============================================================
// TestScheduler — The brain of incremental execution.
//
// WHY: It listens to file changes, computes the "blast radius"
// using the dependency graph, and schedules only the necessary
// tests for execution.
// ============================================================

import type { VirtualFileSystem } from '../vfs/virtual-file-system';
import type { DependencyGraph } from '../dependency-graph/graph';
import type { FileToProjectMapper } from '../nx-resolver/file-mapper';
import type { ExecutionQueue } from './execution-queue';

export class TestScheduler {
    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly graph: DependencyGraph,
        private readonly projectMapper: FileToProjectMapper,
        private readonly queue: ExecutionQueue,
    ) {}

    /**
     * Handle file changes from the VFS.
     * @param changedFiles List of files that were added, changed, or removed
     */
    async onFilesChanged(changedFiles: string[]): Promise<void> {
        const affectedTests = new Set<string>();
        const affectedProjects = new Set<string>();

        for (const filePath of changedFiles) {
            // 1. If it's a test file itself, it is directly affected
            if (this.isTestFile(filePath)) {
                affectedTests.add(filePath);
            }

            // 2. Query the dependency graph for all affected dependents
            const dependents = this.graph.getAffectedFiles(filePath);
            for (const dep of dependents) {
                if (this.isTestFile(dep)) {
                    affectedTests.add(dep);
                }
            }

            // 3. Map to Nx projects for context
            const projects = await this.projectMapper.mapFileToProjects(filePath);
            for (const p of projects) {
                affectedProjects.add(p.name);
            }
        }

        if (affectedTests.size > 0) {
            // 4. Enqueue a test run
            this.queue.enqueue({
                testFiles: affectedTests,
                projectNames: affectedProjects,
                priority: this.calculatePriority(changedFiles),
                timestamp: Date.now(),
            });
        }
    }

    private isTestFile(filePath: string): boolean {
        // Simple heuristic for now: .test. or .spec.
        return /\.test\.(ts|js|tsx|jsx)$/.test(filePath) || /\.spec\.(ts|js|tsx|jsx)$/.test(filePath);
    }

    private calculatePriority(changedFiles: string[]): number {
        // Priority logic: focus on files currently open in editor (buffer source)
        // or smaller sets of changes.
        let score = 10;
        for (const path of changedFiles) {
            const snap = this.vfs.getFile(path);
            if (snap?.source === 'buffer') {
                score += 100; // Unsaved changes get high priority
            }
        }
        return score;
    }
}
