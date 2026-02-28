/**
 * EditorDecorations - Gutter icons and inline annotations for test results.
 *
 * After a test run (real or cached replay), this service decorates the
 * active test file with:
 *
 *  1. Gutter indicators (green check / red cross / grey dash) next to
 *     each test definition line.
 *
 *  2. Inline console-log hints - a faded, truncated label appended after
 *     the code on the same line. On hover, the full console output is
 *     revealed in a MarkdownString tooltip.
 *
 *  3. Inline failure hints - a faded label showing the first line of the
 *     error message, with the full error + diff in the hover tooltip.
 */

import * as path from 'path';
import { Service } from 'typedi';
import * as vscode from 'vscode';
import type { ConsoleLogEntry, TestResult } from './shared-types';

// ---- Decoration type factory ----

function createGutterDecorationType(
  iconPath: vscode.Uri,
): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    gutterIconPath: iconPath,
    gutterIconSize: '80%',
  });
}

// ---- Service ----

@Service()
export class EditorDecorations {
  // Extension URI — set once during activation
  private extensionUri: vscode.Uri | undefined;

  // Gutter decoration types - created lazily after extensionUri is set
  private passedGutter: vscode.TextEditorDecorationType | undefined;
  private failedGutter: vscode.TextEditorDecorationType | undefined;
  private skippedGutter: vscode.TextEditorDecorationType | undefined;

  // Inline annotation decoration types - recreated per-run because the
  // after contentText and hoverMessage vary per-line.
  private inlineDecorationTypes: vscode.TextEditorDecorationType[] = [];

  // Diagnostic collection for Problems panel integration
  private diagnosticCollection =
    vscode.languages.createDiagnosticCollection('wallacy');

  // Track whether this instance has been disposed (stop → restart cycle)
  private isDisposed = false;

  // ---- Current state ----
  private currentFile: string | undefined;
  private currentResults: TestResult[] = [];
  private currentConsoleLogs: ConsoleLogEntry[] = [];

  // ---- Public API ----

  /**
   * Must be called once during extension activation with `context.extensionUri`.
   */
  setExtensionUri(uri: vscode.Uri): void {
    this.extensionUri = uri;
    this.reviveIfDisposed();
    this.ensureGutterTypes();
  }

  /**
   * Called when a new run starts - clears all decorations from the editor.
   */
  clearDecorations(): void {
    this.reviveIfDisposed();
    this.ensureGutterTypes();
    this.applyToEditors(this.currentFile, (editor) => {
      if (this.passedGutter) {
        editor.setDecorations(this.passedGutter, []);
      }
      if (this.failedGutter) {
        editor.setDecorations(this.failedGutter, []);
      }
      if (this.skippedGutter) {
        editor.setDecorations(this.skippedGutter, []);
      }
    });
    this.disposeInlineDecorations();
    this.diagnosticCollection.clear();
    this.currentResults = [];
    this.currentConsoleLogs = [];
    this.currentFile = undefined;
  }

  /**
   * Apply test result decorations (gutter + inline error hints).
   */
  applyTestResults(filePath: string, results: TestResult[]): void {
    this.currentFile = filePath;
    this.currentResults = results;

    // Debug: log what we're trying to decorate
    console.log(
      `[EditorDecorations] applyTestResults: file=${filePath}, results=${results.length}, ` +
        `resultFiles=[${[...new Set(results.map((r) => r.file))].join(', ')}], ` +
        `lines=[${results.map((r) => r.line).join(', ')}], ` +
        `visibleEditors=[${vscode.window.visibleTextEditors.map((e) => e.document.uri.fsPath).join(', ')}]`,
    );

    this.refreshDecorations();
    this.publishDiagnostics(filePath, results);
  }

  /**
   * Apply console log decorations (inline hints with hover).
   */
  applyConsoleLogs(filePath: string, logs: ConsoleLogEntry[]): void {
    this.currentFile = filePath;
    this.currentConsoleLogs = logs;

    // Debug: log console log entries
    console.log(
      `[EditorDecorations] applyConsoleLogs: file=${filePath}, logs=${logs.length}, ` +
        `logFiles=[${[...new Set(logs.map((l) => l.file ?? '(none)'))].join(', ')}], ` +
        `logLines=[${logs.map((l) => l.line ?? '?').join(', ')}]`,
    );

    this.refreshDecorations();
  }

  /**
   * Re-apply decorations to any visible editor matching the current file.
   * Useful when the user switches tabs and comes back.
   */
  refreshForEditor(editor: vscode.TextEditor): void {
    if (
      this.currentFile &&
      this.normalizePath(editor.document.uri.fsPath) ===
        this.normalizePath(this.currentFile)
    ) {
      this.refreshDecorations();
    }
  }

  /**
   * Dispose all decoration types (extension deactivation).
   */
  dispose(): void {
    this.isDisposed = true;
    this.passedGutter?.dispose();
    this.failedGutter?.dispose();
    this.skippedGutter?.dispose();
    // Null out so ensureGutterTypes() re-creates them on next use
    this.passedGutter = undefined;
    this.failedGutter = undefined;
    this.skippedGutter = undefined;
    this.disposeInlineDecorations();
    this.diagnosticCollection.dispose();
    this.currentResults = [];
    this.currentConsoleLogs = [];
    this.currentFile = undefined;
  }

  /**
   * Re-initialise after a dispose (stop → restart cycle).
   * Called automatically when setExtensionUri or clearDecorations is invoked
   * after a previous dispose.
   */
  private reviveIfDisposed(): void {
    if (!this.isDisposed) {
      return;
    }
    this.isDisposed = false;
    // Re-create the diagnostic collection (the old one was disposed)
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection('wallacy');
    // Gutter types will be re-created by ensureGutterTypes()
  }

  // ---- Private ----

  /**
   * Lazily create gutter decoration types once extensionUri is available.
   * Uses SVG files from the media/ directory.
   */
  private ensureGutterTypes(): void {
    if (this.passedGutter) {
      return; // already created
    }
    if (!this.extensionUri) {
      return; // not yet initialised — will be called again
    }
    this.passedGutter = createGutterDecorationType(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'gutter-passed.svg'),
    );
    this.failedGutter = createGutterDecorationType(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'gutter-failed.svg'),
    );
    this.skippedGutter = createGutterDecorationType(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'gutter-skipped.svg'),
    );
  }

  private refreshDecorations(): void {
    if (!this.currentFile) {
      console.log(
        '[EditorDecorations] refreshDecorations: no currentFile, skipping',
      );
      return;
    }

    this.ensureGutterTypes();
    if (!this.passedGutter || !this.failedGutter || !this.skippedGutter) {
      console.log(
        '[EditorDecorations] refreshDecorations: gutter types not ready (extensionUri not set?)',
      );
      return; // extensionUri not yet set
    }

    // Dispose previous inline decorations before creating new ones
    this.disposeInlineDecorations();

    let matchedEditors = 0;
    this.applyToEditors(this.currentFile, (editor) => {
      matchedEditors++;
      console.log(
        `[EditorDecorations] Applying decorations to editor: ${editor.document.uri.fsPath}, ` +
          `results=${this.currentResults.length}, consoleLogs=${this.currentConsoleLogs.length}`,
      );
      this.applyGutterDecorations(editor);
      this.applyInlineDecorations(editor);
    });

    if (matchedEditors === 0) {
      console.log(
        `[EditorDecorations] No matching editors found for ${this.currentFile}. ` +
          `Visible: [${vscode.window.visibleTextEditors.map((e) => e.document.uri.fsPath).join(', ')}]`,
      );
    }
  }

  // ---- Gutter decorations ----

  private applyGutterDecorations(editor: vscode.TextEditor): void {
    const passed: vscode.DecorationOptions[] = [];
    const failed: vscode.DecorationOptions[] = [];
    const skipped: vscode.DecorationOptions[] = [];

    for (const result of this.currentResults) {
      if (result.line === undefined || result.line < 1) {
        continue;
      }
      if (!this.isSameFile(result.file, this.currentFile!)) {
        continue;
      }

      const range = new vscode.Range(result.line - 1, 0, result.line - 1, 0);
      const testLabel =
        result.suite.length > 0
          ? result.suite.join(' > ') + ' > ' + result.name
          : result.name;

      const hoverMessage = new vscode.MarkdownString();
      hoverMessage.isTrusted = true;
      hoverMessage.supportHtml = true;

      if (result.status === 'passed') {
        hoverMessage.appendMarkdown(
          '**PASS** `' + testLabel + '` (' + result.duration + 'ms)',
        );
        passed.push({ range, hoverMessage });
      } else if (result.status === 'failed') {
        hoverMessage.appendMarkdown(
          '**FAIL** `' + testLabel + '` (' + result.duration + 'ms)\n\n',
        );
        if (result.error) {
          hoverMessage.appendMarkdown('---\n\n');
          hoverMessage.appendMarkdown(
            '**' + this.escapeMarkdown(result.error.message) + '**\n\n',
          );
          if (
            result.error.expected !== undefined &&
            result.error.actual !== undefined
          ) {
            hoverMessage.appendMarkdown(
              '**Expected:** `' + String(result.error.expected) + '`\n\n',
            );
            hoverMessage.appendMarkdown(
              '**Actual:** `' + String(result.error.actual) + '`\n\n',
            );
          }
          if (result.error.diff) {
            hoverMessage.appendMarkdown(
              '```diff\n' + result.error.diff + '\n```\n',
            );
          }
          if (result.error.stack) {
            hoverMessage.appendMarkdown(
              '<details><summary>Stack trace</summary>\n\n```\n' +
                result.error.stack +
                '\n```\n\n</details>\n',
            );
          }
        }
        failed.push({ range, hoverMessage });
      } else if (result.status === 'skipped') {
        hoverMessage.appendMarkdown('**SKIP** `' + testLabel + '`');
        skipped.push({ range, hoverMessage });
      }
    }

    editor.setDecorations(this.passedGutter!, passed);
    editor.setDecorations(this.failedGutter!, failed);
    editor.setDecorations(this.skippedGutter!, skipped);
  }

  // ---- Inline decorations (console logs + failure hints) ----

  private applyInlineDecorations(editor: vscode.TextEditor): void {
    // Group console logs by line
    const logsByLine = new Map<number, ConsoleLogEntry[]>();
    for (const log of this.currentConsoleLogs) {
      if (log.line === undefined || log.line < 1) {
        continue;
      }
      if (log.file && !this.isSameFile(log.file, this.currentFile!)) {
        continue;
      }

      const existing = logsByLine.get(log.line) ?? [];
      existing.push(log);
      logsByLine.set(log.line, existing);
    }

    // Create inline decorations for console logs
    for (const [line, logs] of logsByLine) {
      const firstContent = logs[0].content.split('\n')[0];
      const truncated =
        firstContent.length > 60
          ? firstContent.slice(0, 57) + '...'
          : firstContent;
      const label =
        logs.length > 1
          ? 'console: ' + truncated + ' (+' + (logs.length - 1) + ' more)'
          : 'console: ' + truncated;

      const hover = new vscode.MarkdownString();
      hover.isTrusted = true;
      hover.supportHtml = true;
      hover.appendMarkdown(
        '**Console Output** (' +
          logs.length +
          ' log' +
          (logs.length > 1 ? 's' : '') +
          ')\n\n',
      );
      for (const log of logs) {
        const streamLabel = log.stream === 'stderr' ? 'stderr' : 'stdout';
        hover.appendMarkdown('`' + streamLabel + '`\n\n');
        hover.appendMarkdown('```\n' + log.content + '\n```\n\n');
      }

      const decorationType = vscode.window.createTextEditorDecorationType({
        after: {
          contentText: '  ' + label,
          color: new vscode.ThemeColor('editorCodeLens.foreground'),
          fontStyle: 'italic',
        },
        isWholeLine: false,
      });

      const range = new vscode.Range(
        line - 1,
        Number.MAX_SAFE_INTEGER,
        line - 1,
        Number.MAX_SAFE_INTEGER,
      );
      editor.setDecorations(decorationType, [{ range, hoverMessage: hover }]);
      this.inlineDecorationTypes.push(decorationType);
    }

    // Create inline decorations for failed test error messages
    for (const result of this.currentResults) {
      if (result.status !== 'failed') {
        continue;
      }
      if (!result.error || result.line === undefined || result.line < 1) {
        continue;
      }
      if (!this.isSameFile(result.file, this.currentFile!)) {
        continue;
      }

      const firstLine = result.error.message.split('\n')[0];
      const truncated =
        firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;

      const hover = new vscode.MarkdownString();
      hover.isTrusted = true;
      hover.supportHtml = true;
      hover.appendMarkdown('**Test Failure**\n\n');
      hover.appendMarkdown(
        '**' + this.escapeMarkdown(result.error.message) + '**\n\n',
      );
      if (
        result.error.expected !== undefined &&
        result.error.actual !== undefined
      ) {
        hover.appendMarkdown(
          '**Expected:** `' + String(result.error.expected) + '`\n\n',
        );
        hover.appendMarkdown(
          '**Actual:** `' + String(result.error.actual) + '`\n\n',
        );
      }
      if (result.error.diff) {
        hover.appendMarkdown('```diff\n' + result.error.diff + '\n```\n');
      }
      if (result.error.stack) {
        hover.appendMarkdown(
          '<details><summary>Stack trace</summary>\n\n```\n' +
            result.error.stack +
            '\n```\n\n</details>\n',
        );
      }

      const decorationType = vscode.window.createTextEditorDecorationType({
        after: {
          contentText: '  x ' + truncated,
          color: new vscode.ThemeColor('editorError.foreground'),
          fontStyle: 'italic',
        },
        isWholeLine: false,
      });

      const range = new vscode.Range(
        result.line - 1,
        Number.MAX_SAFE_INTEGER,
        result.line - 1,
        Number.MAX_SAFE_INTEGER,
      );
      editor.setDecorations(decorationType, [{ range, hoverMessage: hover }]);
      this.inlineDecorationTypes.push(decorationType);
    }
  }

  // ---- Diagnostics (Problems panel) ----

  private publishDiagnostics(filePath: string, results: TestResult[]): void {
    const diagnostics: vscode.Diagnostic[] = [];

    // Try to find the editor document to read line text for precise underlines
    let document: vscode.TextDocument | undefined;
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.isSameFile(editor.document.uri.fsPath, filePath)) {
        document = editor.document;
        break;
      }
    }

    for (const result of results) {
      if (result.status !== 'failed' || !result.error) {
        continue;
      }
      if (!this.isSameFile(result.file, filePath)) {
        continue;
      }

      // Determine the line — use the test definition line, fall back to the
      // assertion failure line parsed from the stack trace.
      let line =
        (result.line ??
          this.parseErrorLine(result.error.stack, filePath) ??
          1) - 1;
      if (line < 0) {
        line = 0;
      }

      // Try to underline the `it(...)` / `test(...)` call instead of the whole line
      let range: vscode.Range;
      if (document && line < document.lineCount) {
        const lineText = document.lineAt(line).text;
        const itMatch = lineText.match(/\b(it|test|xit|fit)\s*\(/);
        if (itMatch && itMatch.index !== undefined) {
          // Underline from `it(` to the end of the line (covers the test name)
          range = new vscode.Range(line, itMatch.index, line, lineText.length);
        } else {
          // Underline the whole non-whitespace part of the line
          const firstNonWhitespace = lineText.search(/\S/);
          range = new vscode.Range(
            line,
            firstNonWhitespace >= 0 ? firstNonWhitespace : 0,
            line,
            lineText.length,
          );
        }
      } else {
        range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
      }

      const message =
        result.error.message +
        (result.error.expected !== undefined &&
        result.error.actual !== undefined
          ? '\nExpected: ' +
            String(result.error.expected) +
            '\nActual: ' +
            String(result.error.actual)
          : '');

      const diagnostic = new vscode.Diagnostic(
        range,
        message,
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = 'wallacy';
      diagnostic.code =
        result.suite.length > 0
          ? result.suite.join(' > ') + ' > ' + result.name
          : result.name;
      diagnostics.push(diagnostic);
    }

    const uri = vscode.Uri.file(filePath);
    this.diagnosticCollection.set(uri, diagnostics);
  }

  /**
   * Parse the first relevant line number from a Vitest error stack trace.
   * Looks for patterns like `❯ src/file.ts:28:65` or `at src/file.ts:42:15`.
   */
  private parseErrorLine(
    stack: string | undefined,
    filePath: string,
  ): number | undefined {
    if (!stack) {
      return undefined;
    }
    // Match Vitest's ❯ marker or standard `at` lines
    const linePattern =
      /(?:❯\s*|at\s+.*?)(?:[A-Za-z]:[\\/].*?|[\w./\\-]+):(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = linePattern.exec(stack)) !== null) {
      const fullMatch = match[0];
      // Extract the file portion — check if it refers to our test file (not node_modules)
      if (!fullMatch.includes('node_modules')) {
        return parseInt(match[1], 10);
      }
    }
    return undefined;
  }

  // ---- Helpers ----

  private disposeInlineDecorations(): void {
    for (const d of this.inlineDecorationTypes) {
      d.dispose();
    }
    this.inlineDecorationTypes = [];
  }

  private applyToEditors(
    filePath: string | undefined,
    callback: (editor: vscode.TextEditor) => void,
  ): void {
    if (!filePath) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.isSameFile(editor.document.uri.fsPath, filePath)) {
        callback(editor);
      }
    }
  }

  /**
   * Compare two file paths — handles the case where one is absolute and the
   * other is a Vitest moduleId (relative, forward-slash).
   */
  private isSameFile(a: string, b: string): boolean {
    const na = this.normalizePath(a);
    const nb = this.normalizePath(b);
    if (na === nb) {
      return true;
    }
    // One might be relative (Vitest moduleId) while the other is absolute.
    // Ensure the match is at a path separator boundary to avoid false positives.
    if (na.length > nb.length) {
      return na.endsWith('/' + nb) || na.endsWith(nb);
    }
    if (nb.length > na.length) {
      return nb.endsWith('/' + na) || nb.endsWith(na);
    }
    return false;
  }

  private normalizePath(p: string): string {
    // Normalise to forward slashes and lowercase for consistent comparison
    let normalized = path.normalize(p).replace(/\\/g, '/').toLowerCase();
    // Strip leading "/" before drive letter on Windows (Vite produces /C:/...)
    if (/^\/[a-z]:\//.test(normalized)) {
      normalized = normalized.slice(1);
    }
    return normalized;
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
  }
}
