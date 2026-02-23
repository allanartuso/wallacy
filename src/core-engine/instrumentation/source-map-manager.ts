// ============================================================
// SourceMapManager — Handles mapping between instrumented
// code positions and original source positions.
//
// WHY: When an error occurs or a trace event is emitted from
// instrumented code, we need to map those positions back to
// the original source file so the user sees feedback in the
// correct place in VS Code.
// ============================================================

import { SourceMapConsumer } from "source-map";

export interface Position {
  line: number;
  column: number;
}

export interface OriginalPosition extends Position {
  source: string;
}

export class SourceMapManager {
  private consumers = new Map<string, SourceMapConsumer>();

  /**
   * Register a source map for a file.
   * @param filePath Absolute path to the original file
   * @param rawMap JSON string of the source map
   */
  async registerMap(filePath: string, rawMap: string): Promise<void> {
    const map = JSON.parse(rawMap);
    // SourceMapConsumer.with or similar is preferred but for simplicity we'll just new it
    // Note: in modern source-map $(SourceMapConsumer) is async
    const consumer = await new (SourceMapConsumer as any)(map);
    this.consumers.set(filePath, consumer);
  }

  /**
   * Map an instrumented position back to the original source.
   */
  getOriginalPosition(
    filePath: string,
    line: number,
    column: number,
  ): OriginalPosition | undefined {
    const consumer = this.consumers.get(filePath);
    if (!consumer) {
      return undefined;
    }

    const original = consumer.originalPositionFor({ line, column });
    if (!original.source) {
      return undefined;
    }

    return {
      source: original.source,
      line: original.line ?? line,
      column: original.column ?? column,
    };
  }

  /**
   * Remove a map from the manager.
   */
  unregisterMap(filePath: string): void {
    const consumer = this.consumers.get(filePath);
    if (consumer) {
      (consumer as any).destroy?.(); // if modern source-map needs destruction
      this.consumers.delete(filePath);
    }
  }

  /**
   * Clear all registered maps.
   */
  clear(): void {
    for (const [path] of this.consumers) {
      this.unregisterMap(path);
    }
  }
}
