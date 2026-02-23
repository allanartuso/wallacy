import type { TraceEvent } from './execution-tracer';

/**
 * TracingEventStore — a fixed-capacity circular buffer of TraceEvents.
 *
 * When full, oldest events are overwritten. This prevents unbounded memory growth
 * during long test runs while keeping the most recent events accessible.
 */
export class TracingEventStore {
    private buffer: (TraceEvent | undefined)[];
    private head = 0; // index where the next write goes
    private count = 0; // number of valid items currently stored

    constructor(private readonly capacity: number = 10_000) {
        if (capacity <= 0) throw new Error('Capacity must be positive');
        this.buffer = new Array(capacity).fill(undefined);
    }

    /** Add an event. Overwrites the oldest event when the buffer is full. */
    push(event: TraceEvent): void {
        this.buffer[this.head] = event;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity) this.count++;
    }

    /** Return all stored events in insertion order (oldest first). */
    getAll(): TraceEvent[] {
        if (this.count === 0) return [];

        const result: TraceEvent[] = [];
        const startIdx = this.count < this.capacity ? 0 : this.head;

        for (let i = 0; i < this.count; i++) {
            const idx = (startIdx + i) % this.capacity;
            const ev = this.buffer[idx];
            if (ev !== undefined) result.push(ev);
        }

        return result;
    }

    /** Return events filtered by type. */
    getByType(type: TraceEvent['type']): TraceEvent[] {
        return this.getAll().filter(e => e.type === type);
    }

    /** Return events for a specific function name. */
    getByFunction(functionName: string): TraceEvent[] {
        return this.getAll().filter(e => e.functionName === functionName);
    }

    /** Clear all stored events. */
    clear(): void {
        this.buffer.fill(undefined);
        this.head = 0;
        this.count = 0;
    }

    /** Number of events currently stored. */
    get size(): number {
        return this.count;
    }

    /** Whether the store is at capacity (oldest events are being overwritten). */
    get isFull(): boolean {
        return this.count === this.capacity;
    }
}
