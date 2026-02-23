// ============================================================
// VirtualFileSystem — In-memory file snapshots with versioning,
// content-addressable hashing, diffing, and rollback support.
//
// WHY: We must support unsaved editor buffers (like Wallaby).
// The VFS overlays buffer content on top of disk content so
// instrumentation and test execution always use the freshest
// state. Versioning enables efficient change detection.
// ============================================================

import { createHash } from "node:crypto";
import { FileSnapshot, FileDiff } from "../../shared-types";

export type { FileSnapshot, FileDiff };

export class VirtualFileSystem {
  private files = new Map<string, FileSnapshot>();
  private history = new Map<string, FileSnapshot[]>();
  private globalVersion = 0;

  /**
   * Get the current snapshot for a file.
   */
  getFile(filePath: string): FileSnapshot | undefined {
    return this.files.get(this.normalize(filePath));
  }

  /**
   * Update a file from disk content.
   * If a buffer overlay exists and is newer, the buffer wins.
   */
  updateFromDisk(filePath: string, content: string): FileSnapshot {
    const key = this.normalize(filePath);
    const existing = this.files.get(key);

    // If buffer overlay is active and newer, don't overwrite with disk
    if (existing?.source === "buffer") {
      return existing;
    }

    return this.upsert(key, content, "disk");
  }

  /**
   * Update a file from an unsaved editor buffer.
   * Buffer content always takes priority over disk.
   */
  updateFromBuffer(filePath: string, content: string): FileSnapshot {
    const key = this.normalize(filePath);
    return this.upsert(key, content, "buffer");
  }

  /**
   * Clear the buffer overlay, reverting to the last disk snapshot.
   * Returns the reverted snapshot, or undefined if no disk version exists.
   */
  clearBuffer(filePath: string): FileSnapshot | undefined {
    const key = this.normalize(filePath);
    const existing = this.files.get(key);
    if (!existing || existing.source !== "buffer") return existing;

    // Find the last disk snapshot from history
    const fileHistory = this.history.get(key) ?? [];
    const lastDisk = [...fileHistory]
      .reverse()
      .find((s) => s.source === "disk");

    if (lastDisk) {
      this.files.set(key, lastDisk);
      return lastDisk;
    }

    // No disk version in history — remove the file
    this.files.delete(key);
    return undefined;
  }

  /**
   * Remove a file from the VFS (e.g., after deletion on disk).
   */
  removeFile(filePath: string): boolean {
    const key = this.normalize(filePath);
    const existed = this.files.has(key);
    this.files.delete(key);
    return existed;
  }

  /**
   * Get all files that have changed since a given global version.
   */
  getChangedFilesSince(sinceVersion: number): FileSnapshot[] {
    const changed: FileSnapshot[] = [];
    for (const snapshot of this.files.values()) {
      if (snapshot.version > sinceVersion) {
        changed.push(snapshot);
      }
    }
    return changed;
  }

  /**
   * Compute diffs between the current state and a previous version checkpoint.
   */
  diffSince(previousFiles: Map<string, string>): FileDiff[] {
    const diffs: FileDiff[] = [];

    // Check for added and changed files
    for (const [path, snapshot] of this.files) {
      const prevHash = previousFiles.get(path);
      if (prevHash === undefined) {
        diffs.push({ path, type: "added", newHash: snapshot.hash });
      } else if (prevHash !== snapshot.hash) {
        diffs.push({
          path,
          type: "changed",
          oldHash: prevHash,
          newHash: snapshot.hash,
        });
      }
    }

    // Check for removed files
    for (const [path, hash] of previousFiles) {
      if (!this.files.has(path)) {
        diffs.push({ path, type: "removed", oldHash: hash });
      }
    }

    return diffs;
  }

  /**
   * Rollback a file to a specific version from its history.
   * Returns the restored snapshot or undefined if version not found.
   */
  rollback(filePath: string, toVersion: number): FileSnapshot | undefined {
    const key = this.normalize(filePath);
    const fileHistory = this.history.get(key) ?? [];
    const target = fileHistory.find((s) => s.version === toVersion);

    if (target) {
      this.files.set(key, target);
      return target;
    }
    return undefined;
  }

  /**
   * Get the version history for a file.
   */
  getHistory(filePath: string): FileSnapshot[] {
    return this.history.get(this.normalize(filePath)) ?? [];
  }

  /**
   * Take a hash snapshot of all current files (for later diffing).
   */
  takeHashSnapshot(): Map<string, string> {
    const snapshot = new Map<string, string>();
    for (const [path, file] of this.files) {
      snapshot.set(path, file.hash);
    }
    return snapshot;
  }

  /**
   * Get all tracked file paths.
   */
  getAllPaths(): string[] {
    return Array.from(this.files.keys());
  }

  /**
   * Get the current global version counter.
   */
  getGlobalVersion(): number {
    return this.globalVersion;
  }

  /**
   * Get total number of tracked files.
   */
  get size(): number {
    return this.files.size;
  }

  // ─── Private ──────────────────────────────────────────────

  private upsert(
    key: string,
    content: string,
    source: "disk" | "buffer",
  ): FileSnapshot {
    const hash = this.computeHash(content);
    const existing = this.files.get(key);

    // Skip no-op updates (same content)
    if (existing && existing.hash === hash && existing.source === source) {
      return existing;
    }

    this.globalVersion++;
    const snapshot: FileSnapshot = {
      path: key,
      content,
      version: this.globalVersion,
      hash,
      source,
      timestamp: Date.now(),
    };

    // Push previous version to history
    if (existing) {
      const fileHistory = this.history.get(key) ?? [];
      fileHistory.push(existing);
      // Keep last 10 versions max to limit memory
      if (fileHistory.length > 10) {
        fileHistory.shift();
      }
      this.history.set(key, fileHistory);
    }

    this.files.set(key, snapshot);
    return snapshot;
  }

  private computeHash(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  private normalize(filePath: string): string {
    return filePath.replace(/\\/g, "/");
  }
}
