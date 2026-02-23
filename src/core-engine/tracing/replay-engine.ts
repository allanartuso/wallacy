import type { TraceEvent } from './execution-tracer';
import type { SnapshotStore, Snapshot } from './snapshot-store';
import { TracingEventStore } from './tracing-event-store';

export interface ReplayFrame {
    index: number;
    event: TraceEvent;
    snapshot: Snapshot | undefined;
}

/**
 * ReplayEngine — provides a cursor-based navigation over a recorded execution trace.
 *
 * Given a TracingEventStore and a SnapshotStore, the replay engine lets callers
 * step forward/backward through the recorded trace one event at a time,
 * returning the associated variable snapshots at each step.
 *
 * This is the foundation of time-travel debugging.
 */
export class ReplayEngine {
    private events: TraceEvent[] = [];
    private cursor = -1;

    constructor(
        private readonly eventStore: TracingEventStore,
        private readonly snapshotStore: SnapshotStore,
        private readonly testId: string,
    ) {
        this.reset();
    }

    /** Reload events from the store (call after a new test run). */
    reset(): void {
        this.events = this.eventStore.getAll();
        this.cursor = -1;
    }

    /** Total number of events in this replay session. */
    get length(): number {
        return this.events.length;
    }

    /** Current cursor position (-1 = before start). */
    get position(): number {
        return this.cursor;
    }

    /** Whether there is a next frame available. */
    get hasNext(): boolean {
        return this.cursor < this.events.length - 1;
    }

    /** Whether there is a previous frame available. */
    get hasPrev(): boolean {
        return this.cursor > 0;
    }

    /** Step forward one event and return the frame. */
    stepForward(): ReplayFrame | null {
        if (!this.hasNext) return null;
        this.cursor++;
        return this.currentFrame();
    }

    /** Step backward one event and return the frame. */
    stepBackward(): ReplayFrame | null {
        if (!this.hasPrev) return null;
        this.cursor--;
        return this.currentFrame();
    }

    /** Jump to a specific event index. */
    seek(index: number): ReplayFrame | null {
        if (index < 0 || index >= this.events.length) return null;
        this.cursor = index;
        return this.currentFrame();
    }

    /** Return the frame at the current cursor position. */
    currentFrame(): ReplayFrame | null {
        if (this.cursor < 0 || this.cursor >= this.events.length) return null;
        const event = this.events[this.cursor];
        const snapshots = this.snapshotStore.getAtEventIndex(this.testId, this.cursor);
        return {
            index: this.cursor,
            event,
            snapshot: snapshots[0], // most recent snapshot at this index
        };
    }

    /** Get all frames as a flat array (for UI rendering). */
    getAllFrames(): ReplayFrame[] {
        return this.events.map((event, index) => {
            const snapshots = this.snapshotStore.getAtEventIndex(this.testId, index);
            return { index, event, snapshot: snapshots[0] };
        });
    }

    /** Filter frames by event type. */
    getFramesByType(type: TraceEvent['type']): ReplayFrame[] {
        return this.getAllFrames().filter(f => f.event.type === type);
    }
}
