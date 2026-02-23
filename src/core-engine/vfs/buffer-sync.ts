// ============================================================
// BufferSync — Receives unsaved editor buffer content from
// VS Code via IPC and overlays it onto the VFS.
//
// Buffer content always takes priority over disk content.
// When the editor saves, the disk watcher will naturally
// update the VFS with the saved version.
// ============================================================

import { EventEmitter } from 'node:events';
import type { VirtualFileSystem } from './virtual-file-system';

export interface BufferUpdateEvent {
    filePath: string;
    content: string;
    timestamp: number;
}

export class BufferSync extends EventEmitter {
    private activeBuffers = new Set<string>();

    constructor(private readonly vfs: VirtualFileSystem) {
        super();
    }

    /**
     * Apply an unsaved buffer update from the editor.
     * This overlays the buffer content onto the VFS,
     * taking priority over disk content.
     */
    applyBufferUpdate(filePath: string, content: string): void {
        const normalized = filePath.replace(/\\/g, '/');
        this.activeBuffers.add(normalized);
        this.vfs.updateFromBuffer(normalized, content);

        const event: BufferUpdateEvent = {
            filePath: normalized,
            content,
            timestamp: Date.now(),
        };

        this.emit('buffer-update', event);
    }

    /**
     * Clear the buffer overlay for a file (e.g., when the editor saves
     * or closes the file). The VFS will revert to the disk version.
     */
    clearBuffer(filePath: string): void {
        const normalized = filePath.replace(/\\/g, '/');
        this.activeBuffers.delete(normalized);
        this.vfs.clearBuffer(normalized);
        this.emit('buffer-clear', { filePath: normalized });
    }

    /**
     * Clear all active buffer overlays.
     */
    clearAllBuffers(): void {
        for (const filePath of this.activeBuffers) {
            this.vfs.clearBuffer(filePath);
        }
        this.activeBuffers.clear();
        this.emit('all-buffers-cleared');
    }

    /**
     * Check if a file has an active buffer overlay.
     */
    hasActiveBuffer(filePath: string): boolean {
        return this.activeBuffers.has(filePath.replace(/\\/g, '/'));
    }

    /**
     * Get all file paths with active buffer overlays.
     */
    getActiveBufferPaths(): string[] {
        return Array.from(this.activeBuffers);
    }

    /**
     * Get total number of active buffer overlays.
     */
    get activeCount(): number {
        return this.activeBuffers.size;
    }
}
