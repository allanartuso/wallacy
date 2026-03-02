/**
 * Integration tests for the console log → editor decoration pipeline.
 *
 * These tests verify that ConsoleLogEntry[] objects are correctly
 * transformed into the data that EditorDecorations uses for inline
 * annotations and hover content, without requiring the VS Code
 * extension host.
 *
 * We test:
 *   - findConsoleCallSites returns correct positions
 *   - instrumentSource + executeInstrumented produce the right entries
 *   - The entries have the shape that EditorDecorations.applyConsoleLogs expects
 *   - The entries have the shape that the webview console pane expects
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConsoleLogInterceptor,
  findConsoleCallSites,
} from '../console-log-interceptor';
import type { ConsoleLogEntry } from '../shared-types';

// ─── Helpers ────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wallacy-console-decoration-'));
}

function writeFile(dir: string, relativePath: string, content: string): string {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch {
    // Ignore
  }
}

// ─── Tests ──────────────────────────────────────────────────

describe('Console Log → Decoration Pipeline', () => {
  let tmpDir: string;
  let interceptor: ConsoleLogInterceptor;

  beforeEach(() => {
    tmpDir = createTempDir();
    interceptor = new ConsoleLogInterceptor();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  describe('ConsoleLogEntry shape for EditorDecorations', () => {
    it('should produce entries with all required fields', async () => {
      const source = `const x = 42;
console.log("value:", x);`;
      const filePath = writeFile(tmpDir, 'shape.js', source);

      const logs = await interceptor.interceptConsoleLogs(
        filePath,
        source,
        tmpDir,
      );

      expect(logs).toHaveLength(1);
      const entry: ConsoleLogEntry = logs[0];

      // Verify the shape matches what EditorDecorations.applyConsoleLogs expects
      expect(entry).toHaveProperty('stream');
      expect(entry).toHaveProperty('content');
      expect(entry).toHaveProperty('file');
      expect(entry).toHaveProperty('line');
      expect(entry).toHaveProperty('timestamp');

      expect(typeof entry.stream).toBe('string');
      expect(['stdout', 'stderr']).toContain(entry.stream);
      expect(typeof entry.content).toBe('string');
      expect(typeof entry.file).toBe('string');
      expect(typeof entry.line).toBe('number');
      expect(typeof entry.timestamp).toBe('number');
    });

    it('should have line numbers matching actual source positions', async () => {
      const source = `// line 1
// line 2
console.log("on line 3");
// line 4
// line 5
console.log("on line 6");`;
      const filePath = writeFile(tmpDir, 'lines.js', source);

      const logs = await interceptor.interceptConsoleLogs(
        filePath,
        source,
        tmpDir,
      );

      expect(logs).toHaveLength(2);
      expect(logs[0].line).toBe(3);
      expect(logs[1].line).toBe(6);
    });

    it('line numbers should match findConsoleCallSites', async () => {
      const source = `const a = 1;
console.log(a);
const b = "hello";
console.warn(b);
const c = [1, 2, 3];
console.error(c);`;
      const filePath = writeFile(tmpDir, 'match.js', source);

      const sites = findConsoleCallSites(source);
      const logs = await interceptor.interceptConsoleLogs(
        filePath,
        source,
        tmpDir,
      );

      expect(sites).toHaveLength(3);
      expect(logs).toHaveLength(3);

      // Each log's line should match the corresponding call site
      for (let i = 0; i < sites.length; i++) {
        expect(logs[i].line).toBe(sites[i].line);
      }
    });
  });

  describe('ConsoleLogEntry content for webview console pane', () => {
    it('should have file path set for webview source label', async () => {
      const source = `console.log("test");`;
      const filePath = writeFile(tmpDir, 'webview-src.js', source);

      const logs = await interceptor.interceptConsoleLogs(
        filePath,
        source,
        tmpDir,
      );

      expect(logs[0].file).toBe(filePath);
      // Webview will use basename of this to show "webview-src.js:1"
    });

    it('should capture readable content for display', async () => {
      const source = `const user = { id: 'userId1', name: 'userName' };
console.log(user);`;
      const filePath = writeFile(tmpDir, 'display.js', source);

      const logs = await interceptor.interceptConsoleLogs(
        filePath,
        source,
        tmpDir,
      );

      // Content should be human-readable (like what you'd see in a terminal)
      const content = logs[0].content;
      expect(content).toBeTruthy();
      expect(content.length).toBeGreaterThan(0);
      // Should contain the object properties
      expect(content).toContain('id');
      expect(content).toContain('userId1');
      expect(content).toContain('name');
      expect(content).toContain('userName');
    });

    it('should differentiate stdout and stderr for styling', async () => {
      const source = `console.log("stdout message");
console.error("stderr message");`;
      const filePath = writeFile(tmpDir, 'streams.js', source);

      const logs = await interceptor.interceptConsoleLogs(
        filePath,
        source,
        tmpDir,
      );

      // The webview uses stream to apply different CSS classes
      const stdoutEntry = logs.find((l) =>
        l.content.includes('stdout message'),
      );
      const stderrEntry = logs.find((l) =>
        l.content.includes('stderr message'),
      );

      expect(stdoutEntry?.stream).toBe('stdout');
      expect(stderrEntry?.stream).toBe('stderr');
    });
  });

  describe('End-to-end: Quokka-like experience', () => {
    it('should capture inline output next to console.log call (e.g. console.log(user) → { id: ... })', async () => {
      // This simulates the user's example:
      // console.log(user) → shows "{ id: 'userId1', name: 'userName' }" next to the line
      const source = `const user = { id: 'userId1', name: 'userName' };
console.log(user);`;
      const filePath = writeFile(tmpDir, 'quokka-like.js', source);

      const logs = await interceptor.interceptConsoleLogs(
        filePath,
        source,
        tmpDir,
      );

      expect(logs).toHaveLength(1);

      // The decoration will show: "console: { id: 'userId1', name: 'userName' }"
      // next to line 2, and the full output on hover
      const entry = logs[0];
      expect(entry.line).toBe(2);
      expect(entry.file).toBe(filePath);
      expect(entry.content).toContain('userId1');
      expect(entry.content).toContain('userName');

      // Simulate what EditorDecorations would display:
      const firstLine = entry.content.split('\n')[0];
      const truncated =
        firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
      const label = 'console: ' + truncated;

      // The label should be non-empty and contain the output
      expect(label).toBeTruthy();
      expect(label.startsWith('console: ')).toBe(true);
    });

    it('should capture multiple console outputs for a complex file', async () => {
      const source = `// Data processing pipeline
const rawData = [
  { name: "Alice", score: 95 },
  { name: "Bob", score: 82 },
  { name: "Charlie", score: 78 },
];

console.log("Input data:", rawData.length, "records");

const highScorers = rawData.filter(d => d.score >= 80);
console.log("High scorers:", highScorers);

const average = rawData.reduce((sum, d) => sum + d.score, 0) / rawData.length;
console.log("Average score:", average);

const result = { highScorers: highScorers.length, average, processed: true };
console.log("Final result:", result);`;
      const filePath = writeFile(tmpDir, 'pipeline.js', source);

      const logs = await interceptor.interceptConsoleLogs(
        filePath,
        source,
        tmpDir,
      );

      expect(logs).toHaveLength(4);

      // Line 8: console.log("Input data:", ...)
      expect(logs[0].line).toBe(8);
      expect(logs[0].content).toContain('Input data:');
      expect(logs[0].content).toContain('3');

      // Line 11: console.log("High scorers:", ...)
      expect(logs[1].line).toBe(11);
      expect(logs[1].content).toContain('High scorers:');
      expect(logs[1].content).toContain('Alice');
      expect(logs[1].content).toContain('Bob');

      // Line 14: console.log("Average score:", ...)
      expect(logs[2].line).toBe(14);
      expect(logs[2].content).toContain('Average score:');
      expect(logs[2].content).toContain('85');

      // Line 17: console.log("Final result:", ...)
      expect(logs[3].line).toBe(17);
      expect(logs[3].content).toContain('Final result:');
      expect(logs[3].content).toContain('processed');
      expect(logs[3].content).toContain('true');
    });
  });
});
