// ============================================================
// WorkerPool — Placeholder for managing test execution workers.
//
// WHY: In the future, this will manage a pool of worker threads
// or child processes to run tests in parallel without the
// overhead of spawning a new process every time.
// ============================================================

export class WorkerPool {
    private activeWorkers = 0;
    private readonly maxWorkers: number;

    constructor(maxWorkers = 4) {
        this.maxWorkers = maxWorkers;
    }

    async runTask<T>(task: () => Promise<T>): Promise<T> {
        while (this.activeWorkers >= this.maxWorkers) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        this.activeWorkers++;
        try {
            return await task();
        } finally {
            this.activeWorkers--;
        }
    }

    get stats() {
        return {
            active: this.activeWorkers,
            max: this.maxWorkers,
        };
    }
}
