// ============================================================
// ExecutionQueue — Manages a prioritized queue of test runs.
//
// WHY: When multiple files change rapidly, we need to batch
// them and ensure the latest changes are tested first. If a
// run is already in progress, we might want to cancel it or
// queue the next one.
// ============================================================

import type { TestExecutor } from "./executor";

export interface TestRunRequest {
  testFiles: Set<string>;
  projectNames: Set<string>;
  priority: number;
  timestamp: number;
}

export class ExecutionQueue {
  private queue: TestRunRequest[] = [];
  private isProcessing = false;
  private currentRun: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(private readonly executor: TestExecutor) {}

  /**
   * Add a test run request to the queue.
   */
  enqueue(request: TestRunRequest): void {
    // 1. Merge with existing requests if they are for the same projects?
    // For now, just add to queue and sort by priority/timestamp.
    this.queue.push(request);
    this.queue.sort(
      (a, b) => b.priority - a.priority || b.timestamp - a.timestamp,
    );

    // 2. Trigger processing
    this.processNext();
  }

  /**
   * Cancel the current run (if possible) and clear the queue.
   */
  cancelAll(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.queue = [];
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const request = this.queue.shift()!;

    try {
      this.abortController = new AbortController();
      this.currentRun = this.executor.execute(
        request,
        this.abortController.signal,
      );
      await this.currentRun;
    } catch (e) {
      // Handle cancellation or errors
    } finally {
      this.isProcessing = false;
      this.currentRun = null;
      this.abortController = null;
      this.processNext();
    }
  }
}
