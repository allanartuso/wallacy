// ============================================================
// FileWatcher — Chokidar-based file system watcher with
// debouncing. On change, updates the VFS and emits events
// for the scheduler to consume.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { VirtualFileSystem } from "./virtual-file-system";

export type FSWatcher = any; // TODO: import from chokidar

export interface FileChangeEvent {
  type: "add" | "change" | "unlink";
  filePath: string;
  timestamp: number;
}

export interface FileWatcherOptions {
  /** Glob patterns to watch */
  patterns?: string[];
  /** Glob patterns to ignore */
  ignored?: string[];
  /** Debounce delay in ms (default: 100) */
  debounceMs?: number;
}

const DEFAULT_PATTERNS = [
  "**/*.ts",
  "**/*.js",
  "**/*.tsx",
  "**/*.jsx",
  "**/*.mjs",
  "**/*.cjs",
];
const DEFAULT_IGNORED = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/coverage/**",
];

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges = new Map<string, FileChangeEvent>();
  private readonly debounceMs: number;
  private readonly patterns: string[];
  private readonly ignored: string[];

  constructor(
    private readonly watchRoot: string,
    private readonly vfs: VirtualFileSystem,
    options: FileWatcherOptions = {},
  ) {
    super();
    this.debounceMs = options.debounceMs ?? 100;
    this.patterns = options.patterns ?? DEFAULT_PATTERNS;
    this.ignored = options.ignored ?? DEFAULT_IGNORED;
  }

  /**
   * Start watching the file system.
   */
  async start(): Promise<void> {
    if (this.watcher) return;

    const { watch } = await import("chokidar");
    const watchPaths = this.patterns.map((p) => path.join(this.watchRoot, p));

    this.watcher = watch(watchPaths, {
      ignored: this.ignored,
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    });

    this.watcher.on("add", (filePath: any) =>
      this.handleChange("add", filePath),
    );
    this.watcher.on("change", (filePath: any) =>
      this.handleChange("change", filePath),
    );
    this.watcher.on("unlink", (filePath: any) =>
      this.handleChange("unlink", filePath),
    );
    this.watcher.on("error", (error: any) => this.emit("error", error));

    // Wait for the initial scan to complete
    await new Promise<void>((resolve) => {
      this.watcher!.on("ready", resolve);
    });

    this.emit("ready");
  }

  /**
   * Stop watching the file system.
   */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.pendingChanges.clear();
  }

  /**
   * Check if the watcher is currently active.
   */
  isWatching(): boolean {
    return this.watcher !== null;
  }

  // ─── Private ──────────────────────────────────────────────

  private handleChange(
    type: "add" | "change" | "unlink",
    filePath: string,
  ): void {
    const normalized = filePath.replace(/\\/g, "/");

    this.pendingChanges.set(normalized, {
      type,
      filePath: normalized,
      timestamp: Date.now(),
    });

    // Reset debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushChanges();
    }, this.debounceMs);
  }

  private async flushChanges(): Promise<void> {
    const changes = Array.from(this.pendingChanges.values());
    this.pendingChanges.clear();

    if (changes.length === 0) return;

    // Update VFS for each change
    for (const change of changes) {
      try {
        if (change.type === "unlink") {
          this.vfs.removeFile(change.filePath);
        } else {
          const content = await fs.promises.readFile(change.filePath, "utf-8");
          this.vfs.updateFromDisk(change.filePath, content);
        }
      } catch {
        // File might have been deleted between event and read — skip
      }
    }

    // Emit batched change event
    this.emit("changes", changes);
  }
}
