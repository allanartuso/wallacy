// ============================================================
// GraphDiffEngine — Orchestrates incremental updates to the
// DependencyGraph based on file changes.
//
// WHY: When a file changes, we only want to re-scan that specific
// file and update its edges in the graph, rather than re-building
// the entire world.
// ============================================================

import type { DependencyGraph } from './graph';
import type { StaticAnalysisSeed } from './static-analysis';
import type { VirtualFileSystem } from '../vfs/virtual-file-system';

export class GraphDiffEngine {
    constructor(
        private readonly graph: DependencyGraph,
        private readonly scanner: StaticAnalysisSeed,
        private readonly vfs: VirtualFileSystem
    ) { }

    /**
     * Update the graph for a single file change.
     */
    async handleFileChange(filePath: string): Promise<void> {
        const snapshot = this.vfs.getFile(filePath);
        if (!snapshot) {
            // File was removed
            this.graph.removeFile(filePath);
            return;
        }

        // Incremental update:
        // 1. Clear existing static dependencies for this file
        this.graph.clearDependenciesOf(filePath);

        // 2. Re-scan and add new ones
        await this.scanner.scanFile(filePath, snapshot.content);
    }

    /**
     * Update the graph for a batch of changes (e.g. initial scan).
     */
    async handleBatchChanges(filePaths: string[]): Promise<void> {
        await Promise.all(filePaths.map(p => this.handleFileChange(p)));
    }

    /**
     * Add a runtime dependency found via coverage.
     */
    addRuntimeDependency(from: string, to: string): void {
        this.graph.addDependency(from, to, 'runtime');
    }
}
