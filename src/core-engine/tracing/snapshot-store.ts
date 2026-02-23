import type { TraceEvent } from './execution-tracer';

export interface VariableSnapshot {
    name: string;
    value: unknown;
    type: string;
}

export interface Snapshot {
    id: string;
    testId: string;
    eventIndex: number;
    event: TraceEvent;
    variables: VariableSnapshot[];
    capturedAt: number;
}

/**
 * SnapshotStore — associates variable captures with trace events for a test run.
 *
 * Each snapshot represents the state of local variables at a specific execution
 * probe point during a single test. Organized by testId for quick lookup.
 */
export class SnapshotStore {
    private snapshots = new Map<string, Snapshot[]>(); // testId → snapshots
    private nextId = 0;

    /**
     * Record a snapshot of variables at the given trace event.
     */
    record(testId: string, eventIndex: number, event: TraceEvent, variables: Record<string, unknown> = {}): Snapshot {
        const snapshot: Snapshot = {
            id: `snap-${++this.nextId}`,
            testId,
            eventIndex,
            event,
            variables: Object.entries(variables).map(([name, value]) => ({
                name,
                value,
                type: value === null ? 'null' : typeof value,
            })),
            capturedAt: Date.now(),
        };

        if (!this.snapshots.has(testId)) {
            this.snapshots.set(testId, []);
        }
        this.snapshots.get(testId)!.push(snapshot);

        return snapshot;
    }

    /** Get all snapshots for a test. */
    getForTest(testId: string): Snapshot[] {
        return this.snapshots.get(testId) ?? [];
    }

    /** Get a specific snapshot by ID. */
    getById(id: string): Snapshot | undefined {
        for (const snapshots of this.snapshots.values()) {
            const found = snapshots.find(s => s.id === id);
            if (found) return found;
        }
        return undefined;
    }

    /** Get all snapshots at a particular event index for a test. */
    getAtEventIndex(testId: string, eventIndex: number): Snapshot[] {
        return this.getForTest(testId).filter(s => s.eventIndex === eventIndex);
    }

    /** Clear all snapshots for a test (e.g., before a re-run). */
    clearForTest(testId: string): void {
        this.snapshots.delete(testId);
    }

    /** Clear all snapshots. */
    clearAll(): void {
        this.snapshots.clear();
        this.nextId = 0;
    }

    /** Total number of snapshots. */
    get size(): number {
        let total = 0;
        for (const arr of this.snapshots.values()) total += arr.length;
        return total;
    }
}
