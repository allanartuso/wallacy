// ============================================================
// DependencyGraph — Manages the bi-directional relationship
// between files (source files, test files, configs).
//
// WHY: To achieve minimal re-execution, we need to know exactly
// which test files depend on which source files. This graph
// supports both static imports and runtime coverage data.
// ============================================================

export type DependencyType = 'static' | 'runtime';

export interface DependencyEdge {
    from: string; // Source file
    to: string;   // Test file (or dependent source file)
    type: DependencyType;
}

export class DependencyGraph {
    // Map of file -> files that depend on it
    private dependents = new Map<string, Set<string>>();
    // Map of file -> files it depends on
    private dependencies = new Map<string, Set<string>>();
    // Edge metadata (type)
    private edgeTypes = new Map<string, DependencyType>();

    /**
     * Add a dependency: 'to' depends on 'from'.
     * @param from The file being depended upon (e.g., a utility)
     * @param to The file that depends on it (e.g., a test or another utility)
     * @param type Whether this was found via static imports or runtime coverage
     */
    addDependency(from: string, to: string, type: DependencyType): void {
        const fromKey = this.normalize(from);
        const toKey = this.normalize(to);

        if (fromKey === toKey) return;

        if (!this.dependents.has(fromKey)) this.dependents.set(fromKey, new Set());
        if (!this.dependencies.has(toKey)) this.dependencies.set(toKey, new Set());

        this.dependents.get(fromKey)!.add(toKey);
        this.dependencies.get(toKey)!.add(fromKey);

        const edgeKey = `${fromKey}->${toKey}`;
        // Runtime edge overrides static for higher precision
        if (type === 'runtime' || !this.edgeTypes.has(edgeKey)) {
            this.edgeTypes.set(edgeKey, type);
        }
    }

    /**
     * Get all files that directy or transitively depend on the given file.
     */
    getAffectedFiles(filePath: string): Set<string> {
        const affected = new Set<string>();
        const normalized = this.normalize(filePath);
        const queue = [normalized];
        const visited = new Set<string>();

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current)) continue;
            visited.add(current);

            const directDependents = this.dependents.get(current);
            if (directDependents) {
                for (const dep of directDependents) {
                    affected.add(dep);
                    queue.push(dep);
                }
            }
        }

        return affected;
    }

    /**
     * Clear all dependencies for a specific file (e.g., when it's about to be re-analyzed).
     */
    clearDependenciesOf(filePath: string): void {
        const toKey = this.normalize(filePath);
        const fromKeys = this.dependencies.get(toKey);
        if (fromKeys) {
            for (const fromKey of fromKeys) {
                this.dependents.get(fromKey)?.delete(toKey);
                this.edgeTypes.delete(`${fromKey}->${toKey}`);
            }
            this.dependencies.delete(toKey);
        }
    }

    /**
     * Remove a file entirely from the graph.
     */
    removeFile(filePath: string): void {
        const key = this.normalize(filePath);
        this.clearDependenciesOf(key);

        // Also remove as a dependency for others
        const affected = this.dependents.get(key);
        if (affected) {
            for (const dep of affected) {
                this.dependencies.get(dep)?.delete(key);
                this.edgeTypes.delete(`${key}->${dep}`);
            }
            this.dependents.delete(key);
        }
    }

    /**
     * Get the type of a specific edge.
     */
    getEdgeType(from: string, to: string): DependencyType | undefined {
        return this.edgeTypes.get(`${this.normalize(from)}->${this.normalize(to)}`);
    }

    /**
     * Get total number of nodes (files) in the graph.
     */
    get nodeCount(): number {
        const allFiles = new Set([...this.dependents.keys(), ...this.dependencies.keys()]);
        return allFiles.size;
    }

    private normalize(p: string): string {
        // 1. Normalize slashes to forward
        let normalized = p.replace(/\\/g, '/');
        // 2. Remove drive letter (e.g. C:)
        normalized = normalized.replace(/^[a-zA-Z]:/, '');
        // 3. Ensure it starts with / 
        if (!normalized.startsWith('/')) {
            normalized = '/' + normalized;
        }
        // 4. Resolve . and .. components to avoid /src/../baz
        // We'll use a simple stack-based approach since we want to stay POSIX
        const parts = normalized.split('/');
        const stack: string[] = [];
        for (const part of parts) {
            if (part === '.' || part === '') continue;
            if (part === '..') {
                stack.pop();
            } else {
                stack.push(part);
            }
        }
        return '/' + stack.join('/');
    }
}


