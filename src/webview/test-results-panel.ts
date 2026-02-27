/**
 * TestResultsPanel — Manages a VS Code Webview panel that displays
 * test results, error diffs, and console output in a rich UI.
 *
 * Uses message passing between the extension and the webview.
 * The panel is a singleton — calling `createOrShow()` will reuse
 * an existing panel or create a new one.
 */

import {Service} from "typedi";
import * as vscode from "vscode";
import type {CollectedResults, ConsoleLogEntry, SmartStartResult, TestInfo, TestResult} from "../shared-types";

// ─── Message types: Extension → Webview ─────────────────────

export type WebviewMessage =
  | {type: "clear"}
  | {type: "resolution"; data: ResolutionPayload}
  | {type: "testsDiscovered"; data: TestInfo[]}
  | {type: "testResult"; data: TestResult}
  | {type: "runComplete"; data: RunCompletePayload}
  | {type: "consoleLog"; data: ConsoleLogEntry}
  | {type: "runStarted"; data: {file: string; timestamp: number}};

export interface ResolutionPayload {
  projectName: string;
  projectRoot: string;
  testFramework: string;
  configPath: string | null;
  tsconfigPath: string | null;
  dependents: string[];
}

export interface RunCompletePayload {
  results: TestResult[];
  duration: number;
  passed: number;
  failed: number;
  skipped: number;
}

// ─── Message types: Webview → Extension ─────────────────────

export type WebviewIncomingMessage =
  | {type: "openFile"; file: string; line?: number}
  | {type: "rerun"}
  | {type: "ready"};

// ─── Panel ──────────────────────────────────────────────────

@Service()
export class TestResultsPanel {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private pendingMessages: WebviewMessage[] = [];
  private webviewReady = false;

  /** Callback for when the user clicks "Re-run" */
  onRerunRequested?: () => void;

  /**
   * Show the panel (create if needed), clear previous results.
   */
  createOrShow(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "wallacy.testResults",
      "Wallacy — Test Results",
      {viewColumn: vscode.ViewColumn.Beside, preserveFocus: true},
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    this.panel.iconPath = new vscode.ThemeIcon("beaker");
    this.panel.webview.html = this.getHtmlContent();
    this.webviewReady = false;

    // Listen for messages from the webview
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewIncomingMessage) => {
        switch (message.type) {
          case "openFile":
            this.handleOpenFile(message.file, message.line);
            break;
          case "rerun":
            this.onRerunRequested?.();
            break;
          case "ready":
            this.webviewReady = true;
            this.flushPendingMessages();
            break;
        }
      },
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.webviewReady = false;
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
      },
      undefined,
      this.disposables,
    );
  }

  /**
   * Send a message to the webview. If the webview isn't ready yet, queue it.
   */
  postMessage(message: WebviewMessage): void {
    if (this.webviewReady && this.panel) {
      this.panel.webview.postMessage(message);
    } else {
      this.pendingMessages.push(message);
    }
  }

  // ─── Convenience methods ────────────────────────────────

  clear(): void {
    this.postMessage({type: "clear"});
  }

  notifyRunStarted(file: string): void {
    this.postMessage({type: "runStarted", data: {file, timestamp: Date.now()}});
  }

  notifyResolution(result: SmartStartResult): void {
    this.postMessage({
      type: "resolution",
      data: {
        projectName: result.project.name,
        projectRoot: result.project.root,
        testFramework: result.testFramework,
        configPath: result.configPath,
        tsconfigPath: result.tsconfigPath,
        dependents: result.dependents,
      },
    });
  }

  notifyTestsDiscovered(tests: TestInfo[]): void {
    this.postMessage({type: "testsDiscovered", data: tests});
  }

  notifyTestResult(result: TestResult): void {
    this.postMessage({type: "testResult", data: result});
  }

  notifyRunComplete(collected: CollectedResults): void {
    const passed = collected.results.filter((r) => r.status === "passed").length;
    const failed = collected.results.filter((r) => r.status === "failed").length;
    const skipped = collected.results.filter((r) => r.status === "skipped").length;

    this.postMessage({
      type: "runComplete",
      data: {
        results: collected.results,
        duration: collected.duration,
        passed,
        failed,
        skipped,
      },
    });
  }

  notifyConsoleLog(entry: ConsoleLogEntry): void {
    this.postMessage({type: "consoleLog", data: entry});
  }

  dispose(): void {
    this.panel?.dispose();
  }

  // ─── Private ──────────────────────────────────────────────

  private flushPendingMessages(): void {
    for (const msg of this.pendingMessages) {
      this.panel?.webview.postMessage(msg);
    }
    this.pendingMessages = [];
  }

  private handleOpenFile(file: string, line?: number): void {
    const uri = vscode.Uri.file(file);
    const options: vscode.TextDocumentShowOptions = {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    };
    if (line !== undefined && line > 0) {
      const pos = new vscode.Position(line - 1, 0);
      options.selection = new vscode.Range(pos, pos);
    }
    vscode.window.showTextDocument(uri, options);
  }

  // ─── HTML ─────────────────────────────────────────────────

  private getHtmlContent(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Wallacy — Test Results</title>
  <style>
    ${this.getCss()}
  </style>
</head>
<body>
  <!-- Header -->
  <header id="header">
    <div class="header-left">
      <span class="logo">🧪</span>
      <h1>Wallacy</h1>
      <span id="project-badge" class="badge hidden"></span>
      <span id="framework-badge" class="badge badge-framework hidden"></span>
    </div>
    <div class="header-right">
      <button id="btn-rerun" class="btn btn-primary hidden" title="Re-run tests">
        <span class="icon">▶</span> Re-run
      </button>
    </div>
  </header>

  <!-- Summary bar -->
  <div id="summary-bar" class="summary-bar hidden">
    <div class="summary-stat summary-passed">
      <span class="summary-icon">✓</span>
      <span id="stat-passed">0</span> passed
    </div>
    <div class="summary-stat summary-failed">
      <span class="summary-icon">✗</span>
      <span id="stat-failed">0</span> failed
    </div>
    <div class="summary-stat summary-skipped">
      <span class="summary-icon">○</span>
      <span id="stat-skipped">0</span> skipped
    </div>
    <div class="summary-stat summary-duration">
      <span class="summary-icon">⏱</span>
      <span id="stat-duration">0</span>ms
    </div>
  </div>

  <!-- Tabs -->
  <nav id="tab-bar" class="tab-bar">
    <button class="tab active" data-tab="results">Results</button>
    <button class="tab" data-tab="console">Console <span id="console-count" class="tab-count hidden">0</span></button>
  </nav>

  <!-- Tab content: Results -->
  <main id="tab-results" class="tab-content active">
    <div id="spinner" class="spinner-container">
      <div class="spinner"></div>
      <p>Resolving project…</p>
    </div>
    <div id="results-list" class="results-list hidden"></div>
    <div id="empty-state" class="empty-state hidden">
      <p>No test results yet. Run <strong>Wallacy: Smart Start</strong> on a test file.</p>
    </div>
  </main>

  <!-- Tab content: Console -->
  <main id="tab-console" class="tab-content">
    <div id="console-list" class="console-list"></div>
    <div id="console-empty" class="empty-state">
      <p>No console output captured.</p>
    </div>
  </main>

  <script>
    ${this.getJs()}
  </script>
</body>
</html>`;
  }

  // ─── CSS ──────────────────────────────────────────────────

  private getCss(): string {
    return /* css */ `
      :root {
        --bg: var(--vscode-editor-background);
        --fg: var(--vscode-editor-foreground);
        --border: var(--vscode-panel-border, var(--vscode-widget-border, #333));
        --card-bg: var(--vscode-editorWidget-background, var(--vscode-sideBar-background, #1e1e1e));
        --hover-bg: var(--vscode-list-hoverBackground, #2a2d2e);
        --green: var(--vscode-testing-iconPassed, #73c991);
        --red: var(--vscode-testing-iconFailed, #f14c4c);
        --yellow: var(--vscode-testing-iconSkipped, #cca700);
        --blue: var(--vscode-textLink-foreground, #3794ff);
        --muted: var(--vscode-descriptionForeground, #888);
        --diff-add-bg: var(--vscode-diffEditor-insertedTextBackground, rgba(115, 201, 145, 0.15));
        --diff-remove-bg: var(--vscode-diffEditor-removedTextBackground, rgba(241, 76, 76, 0.15));
        --font-mono: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
        --font-size: var(--vscode-editor-font-size, 13px);
        --radius: 6px;
      }

      * { margin: 0; padding: 0; box-sizing: border-box; }

      body {
        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
        font-size: var(--font-size);
        color: var(--fg);
        background: var(--bg);
        line-height: 1.5;
        overflow-x: hidden;
      }

      /* Header */
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 16px;
        border-bottom: 1px solid var(--border);
        background: var(--card-bg);
      }
      .header-left { display: flex; align-items: center; gap: 8px; }
      .header-right { display: flex; align-items: center; gap: 8px; }
      .logo { font-size: 20px; }
      h1 { font-size: 15px; font-weight: 600; }

      .badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 10px;
        background: var(--vscode-badge-background, #4d4d4d);
        color: var(--vscode-badge-foreground, #fff);
        white-space: nowrap;
      }
      .badge-framework { background: var(--blue); color: #fff; }

      /* Button */
      .btn {
        display: flex; align-items: center; gap: 4px;
        padding: 4px 12px;
        border: none; border-radius: var(--radius);
        font-size: 12px; cursor: pointer;
        color: var(--fg);
        background: var(--vscode-button-secondaryBackground, #333);
      }
      .btn:hover { background: var(--vscode-button-secondaryHoverBackground, #444); }
      .btn-primary {
        background: var(--vscode-button-background, #0e639c);
        color: var(--vscode-button-foreground, #fff);
      }
      .btn-primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
      .icon { font-size: 10px; }

      /* Summary bar */
      .summary-bar {
        display: flex; align-items: center; gap: 20px;
        padding: 8px 16px;
        border-bottom: 1px solid var(--border);
        background: var(--card-bg);
        font-size: 13px;
      }
      .summary-stat { display: flex; align-items: center; gap: 4px; }
      .summary-icon { font-size: 14px; }
      .summary-passed .summary-icon { color: var(--green); }
      .summary-failed .summary-icon { color: var(--red); }
      .summary-skipped .summary-icon { color: var(--yellow); }
      .summary-duration .summary-icon { color: var(--muted); }

      /* Tabs */
      .tab-bar {
        display: flex;
        border-bottom: 1px solid var(--border);
        background: var(--card-bg);
        padding: 0 12px;
      }
      .tab {
        padding: 8px 16px;
        border: none;
        background: none;
        color: var(--muted);
        font-size: 13px;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        transition: all 0.15s;
      }
      .tab:hover { color: var(--fg); }
      .tab.active {
        color: var(--fg);
        border-bottom-color: var(--blue);
      }
      .tab-count {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 18px; height: 18px;
        margin-left: 4px;
        padding: 0 5px;
        border-radius: 9px;
        font-size: 10px;
        background: var(--vscode-badge-background, #4d4d4d);
        color: var(--vscode-badge-foreground, #fff);
      }

      /* Tab content */
      .tab-content { display: none; padding: 12px 16px; }
      .tab-content.active { display: block; }

      /* Spinner */
      .spinner-container {
        display: flex; flex-direction: column; align-items: center;
        gap: 12px; padding: 40px; color: var(--muted);
      }
      .spinner {
        width: 28px; height: 28px;
        border: 3px solid var(--border);
        border-top-color: var(--blue);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }

      /* Empty state */
      .empty-state {
        padding: 40px; text-align: center; color: var(--muted);
      }

      /* Results list */
      .results-list { display: flex; flex-direction: column; gap: 4px; }

      /* Test result row */
      .test-row {
        display: flex; flex-direction: column;
        border-radius: var(--radius);
        background: var(--card-bg);
        overflow: hidden;
        border: 1px solid transparent;
        transition: border-color 0.15s;
      }
      .test-row:hover { border-color: var(--border); }

      .test-row-header {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px;
        cursor: pointer;
        user-select: none;
      }

      .status-icon {
        flex-shrink: 0;
        width: 20px; height: 20px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 50%;
        font-size: 12px; font-weight: 700;
      }
      .status-passed { color: var(--green); background: rgba(115, 201, 145, 0.1); }
      .status-failed { color: var(--red); background: rgba(241, 76, 76, 0.1); }
      .status-skipped { color: var(--yellow); background: rgba(204, 167, 0, 0.1); }

      .test-name { flex: 1; font-weight: 500; }
      .test-suite {
        color: var(--muted); font-size: 12px;
        margin-right: 4px;
      }
      .test-duration { color: var(--muted); font-size: 12px; white-space: nowrap; }
      .test-file-link {
        color: var(--blue); font-size: 11px; cursor: pointer;
        white-space: nowrap;
        text-decoration: none;
      }
      .test-file-link:hover { text-decoration: underline; }

      /* Error details (expandable) */
      .test-error {
        display: none;
        padding: 0 12px 12px;
      }
      .test-row.expanded .test-error { display: block; }

      .error-message {
        font-family: var(--font-mono);
        font-size: 12px;
        padding: 8px 12px;
        background: var(--diff-remove-bg);
        border-radius: var(--radius);
        white-space: pre-wrap;
        word-break: break-word;
        margin-bottom: 8px;
        border-left: 3px solid var(--red);
      }

      /* Diff display */
      .diff-container {
        font-family: var(--font-mono);
        font-size: 12px;
        border-radius: var(--radius);
        overflow: hidden;
        border: 1px solid var(--border);
        margin-bottom: 8px;
      }
      .diff-header {
        padding: 6px 12px;
        background: var(--card-bg);
        border-bottom: 1px solid var(--border);
        font-weight: 600;
        font-size: 11px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .diff-side {
        display: flex;
      }
      .diff-expected, .diff-actual {
        flex: 1;
        padding: 8px 12px;
        white-space: pre-wrap;
        word-break: break-word;
        min-width: 0;
      }
      .diff-expected {
        background: var(--diff-remove-bg);
        border-right: 1px solid var(--border);
      }
      .diff-actual {
        background: var(--diff-add-bg);
      }
      .diff-label {
        display: block;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
      }
      .diff-label-expected { color: var(--red); }
      .diff-label-actual { color: var(--green); }

      /* Stack trace */
      .stack-trace {
        font-family: var(--font-mono);
        font-size: 11px;
        color: var(--muted);
        padding: 8px 12px;
        background: var(--card-bg);
        border-radius: var(--radius);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 200px;
        overflow-y: auto;
        border: 1px solid var(--border);
      }
      .stack-link {
        color: var(--blue);
        cursor: pointer;
        text-decoration: none;
      }
      .stack-link:hover { text-decoration: underline; }

      /* File group header */
      .file-group {
        margin-bottom: 12px;
      }
      .file-group-header {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 0;
        font-weight: 600;
        font-size: 13px;
        color: var(--fg);
        border-bottom: 1px solid var(--border);
        margin-bottom: 6px;
      }
      .file-group-icon { font-size: 14px; }
      .file-group-name {
        cursor: pointer;
        color: var(--blue);
      }
      .file-group-name:hover { text-decoration: underline; }
      .file-group-stats {
        margin-left: auto;
        font-size: 11px;
        color: var(--muted);
        font-weight: 400;
      }

      /* Console section */
      .console-list { display: flex; flex-direction: column; gap: 2px; }
      .console-entry {
        font-family: var(--font-mono);
        font-size: 12px;
        padding: 4px 12px;
        border-radius: 3px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .console-entry-stdout { color: var(--fg); }
      .console-entry-stderr { color: var(--red); background: var(--diff-remove-bg); }
      .console-source {
        color: var(--blue);
        font-size: 11px;
        cursor: pointer;
      }
      .console-source:hover { text-decoration: underline; }

      .hidden { display: none !important; }

      /* Scrollbar styling */
      ::-webkit-scrollbar { width: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb {
        background: var(--vscode-scrollbarSlider-background, #424242);
        border-radius: 4px;
      }
      ::-webkit-scrollbar-thumb:hover {
        background: var(--vscode-scrollbarSlider-hoverBackground, #555);
      }
    `;
  }

  // ─── JavaScript ───────────────────────────────────────────

  private getJs(): string {
    return /* js */ `
      const vscode = acquireVsCodeApi();

      // ─── State ──────────────────────────────────────────
      let allResults = [];
      let consoleLogs = [];

      // ─── DOM refs ───────────────────────────────────────
      const $ = (sel) => document.querySelector(sel);
      const $$ = (sel) => document.querySelectorAll(sel);

      const spinner = $('#spinner');
      const resultsList = $('#results-list');
      const emptyState = $('#empty-state');
      const summaryBar = $('#summary-bar');
      const projectBadge = $('#project-badge');
      const frameworkBadge = $('#framework-badge');
      const btnRerun = $('#btn-rerun');
      const consoleList = $('#console-list');
      const consoleEmpty = $('#console-empty');
      const consoleCount = $('#console-count');

      // ─── Tab switching ──────────────────────────────────
      $$('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
          $$('.tab').forEach(t => t.classList.remove('active'));
          $$('.tab-content').forEach(tc => tc.classList.remove('active'));
          tab.classList.add('active');
          const target = tab.getAttribute('data-tab');
          $('#tab-' + target).classList.add('active');
        });
      });

      // ─── Button handlers ────────────────────────────────
      btnRerun.addEventListener('click', () => {
        vscode.postMessage({ type: 'rerun' });
      });

      // ─── Message handler ────────────────────────────────
      window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
          case 'clear':
            handleClear();
            break;
          case 'runStarted':
            handleRunStarted(msg.data);
            break;
          case 'resolution':
            handleResolution(msg.data);
            break;
          case 'testsDiscovered':
            handleTestsDiscovered(msg.data);
            break;
          case 'testResult':
            handleTestResult(msg.data);
            break;
          case 'runComplete':
            handleRunComplete(msg.data);
            break;
          case 'consoleLog':
            handleConsoleLog(msg.data);
            break;
        }
      });

      // ─── Handlers ───────────────────────────────────────

      function handleClear() {
        allResults = [];
        consoleLogs = [];
        resultsList.innerHTML = '';
        resultsList.classList.add('hidden');
        consoleList.innerHTML = '';
        consoleEmpty.classList.remove('hidden');
        consoleCount.classList.add('hidden');
        summaryBar.classList.add('hidden');
        emptyState.classList.add('hidden');
        spinner.classList.remove('hidden');
        spinner.querySelector('p').textContent = 'Resolving project…';
        projectBadge.classList.add('hidden');
        frameworkBadge.classList.add('hidden');
        btnRerun.classList.add('hidden');
      }

      function handleRunStarted(data) {
        handleClear();
        const fileName = data.file.split(/[\\\\/]/).pop();
        spinner.querySelector('p').textContent = 'Resolving project for ' + fileName + '…';
      }

      function handleResolution(data) {
        projectBadge.textContent = data.projectName;
        projectBadge.classList.remove('hidden');
        frameworkBadge.textContent = data.testFramework;
        frameworkBadge.classList.remove('hidden');
        spinner.querySelector('p').textContent = 'Discovering tests…';
      }

      function handleTestsDiscovered(tests) {
        spinner.querySelector('p').textContent = 'Running ' + tests.length + ' test(s)…';
      }

      function handleTestResult(result) {
        allResults.push(result);

        // Hide spinner, show results
        spinner.classList.add('hidden');
        resultsList.classList.remove('hidden');
        emptyState.classList.add('hidden');

        // Update summary (live)
        updateSummary();

        // Re-render results grouped by file
        renderResults();
      }

      function handleRunComplete(data) {
        spinner.classList.add('hidden');
        btnRerun.classList.remove('hidden');

        if (allResults.length === 0 && data.results.length > 0) {
          allResults = data.results;
        }

        updateSummary();
        renderResults();

        if (allResults.length === 0) {
          resultsList.classList.add('hidden');
          emptyState.classList.remove('hidden');
        }
      }

      function handleConsoleLog(entry) {
        consoleLogs.push(entry);
        consoleEmpty.classList.add('hidden');
        consoleCount.textContent = consoleLogs.length;
        consoleCount.classList.remove('hidden');

        const el = document.createElement('div');
        el.className = 'console-entry console-entry-' + entry.stream;

        let sourceHtml = '';
        if (entry.file) {
          const fileName = entry.file.split(/[\\\\/]/).pop();
          const lineStr = entry.line ? ':' + entry.line : '';
          sourceHtml = '<span class="console-source" data-file="' +
            escapeAttr(entry.file) + '" data-line="' + (entry.line || '') +
            '">' + escapeHtml(fileName + lineStr) + '</span> ';
        }

        el.innerHTML = sourceHtml + escapeHtml(entry.content);
        consoleList.appendChild(el);

        // Wire up source click
        const sourceEl = el.querySelector('.console-source');
        if (sourceEl) {
          sourceEl.addEventListener('click', () => {
            vscode.postMessage({
              type: 'openFile',
              file: sourceEl.getAttribute('data-file'),
              line: parseInt(sourceEl.getAttribute('data-line')) || undefined,
            });
          });
        }
      }

      // ─── Rendering ─────────────────────────────────────

      function updateSummary() {
        const passed = allResults.filter(r => r.status === 'passed').length;
        const failed = allResults.filter(r => r.status === 'failed').length;
        const skipped = allResults.filter(r => r.status === 'skipped').length;
        const totalDuration = allResults.reduce((sum, r) => sum + (r.duration || 0), 0);

        $('#stat-passed').textContent = passed;
        $('#stat-failed').textContent = failed;
        $('#stat-skipped').textContent = skipped;
        $('#stat-duration').textContent = Math.round(totalDuration);
        summaryBar.classList.remove('hidden');
      }

      function renderResults() {
        // Group by file
        const groups = {};
        for (const r of allResults) {
          const file = r.file || 'unknown';
          if (!groups[file]) groups[file] = [];
          groups[file].push(r);
        }

        resultsList.innerHTML = '';

        for (const [file, results] of Object.entries(groups)) {
          const groupEl = document.createElement('div');
          groupEl.className = 'file-group';

          const filePassed = results.filter(r => r.status === 'passed').length;
          const fileFailed = results.filter(r => r.status === 'failed').length;
          const fileSkipped = results.filter(r => r.status === 'skipped').length;
          const fileName = file.split(/[\\\\/]/).pop();

          groupEl.innerHTML =
            '<div class="file-group-header">' +
              '<span class="file-group-icon">' + (fileFailed > 0 ? '📄' : '📄') + '</span>' +
              '<span class="file-group-name" data-file="' + escapeAttr(file) + '">' + escapeHtml(fileName) + '</span>' +
              '<span class="file-group-stats">' +
                (filePassed > 0 ? '<span style="color:var(--green)">' + filePassed + ' ✓</span> ' : '') +
                (fileFailed > 0 ? '<span style="color:var(--red)">' + fileFailed + ' ✗</span> ' : '') +
                (fileSkipped > 0 ? '<span style="color:var(--yellow)">' + fileSkipped + ' ○</span>' : '') +
              '</span>' +
            '</div>';

          // Wire file name click
          const fileNameEl = groupEl.querySelector('.file-group-name');
          fileNameEl.addEventListener('click', () => {
            vscode.postMessage({ type: 'openFile', file: file });
          });

          for (const result of results) {
            groupEl.appendChild(createTestRow(result));
          }

          resultsList.appendChild(groupEl);
        }
      }

      function createTestRow(result) {
        const row = document.createElement('div');
        row.className = 'test-row';
        if (result.status === 'failed') row.classList.add('expanded');

        // Header
        const header = document.createElement('div');
        header.className = 'test-row-header';

        const statusIcon = document.createElement('div');
        statusIcon.className = 'status-icon status-' + result.status;
        statusIcon.textContent = result.status === 'passed' ? '✓' : result.status === 'failed' ? '✗' : '○';

        const suiteSpan = document.createElement('span');
        suiteSpan.className = 'test-suite';
        if (result.suite && result.suite.length > 0) {
          suiteSpan.textContent = result.suite.join(' › ') + ' › ';
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'test-name';
        nameSpan.appendChild(suiteSpan);
        nameSpan.appendChild(document.createTextNode(result.name));

        const durationSpan = document.createElement('span');
        durationSpan.className = 'test-duration';
        durationSpan.textContent = (result.duration || 0) + 'ms';

        header.appendChild(statusIcon);
        header.appendChild(nameSpan);
        header.appendChild(durationSpan);

        if (result.line && result.file) {
          const fileLink = document.createElement('a');
          fileLink.className = 'test-file-link';
          fileLink.textContent = ':' + result.line;
          fileLink.title = 'Open in editor';
          fileLink.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'openFile', file: result.file, line: result.line });
          });
          header.appendChild(fileLink);
        }

        // Toggle expand on header click
        header.addEventListener('click', () => {
          row.classList.toggle('expanded');
        });

        row.appendChild(header);

        // Error details
        if (result.error) {
          const errorDiv = document.createElement('div');
          errorDiv.className = 'test-error';

          // Error message
          const msgDiv = document.createElement('div');
          msgDiv.className = 'error-message';
          msgDiv.textContent = result.error.message || 'Unknown error';
          errorDiv.appendChild(msgDiv);

          // Expected vs Actual diff
          if (result.error.expected !== undefined || result.error.actual !== undefined) {
            const diffContainer = document.createElement('div');
            diffContainer.className = 'diff-container';

            const diffHeader = document.createElement('div');
            diffHeader.className = 'diff-header';
            diffHeader.textContent = 'Expected vs Actual';
            diffContainer.appendChild(diffHeader);

            const diffSide = document.createElement('div');
            diffSide.className = 'diff-side';

            const expectedDiv = document.createElement('div');
            expectedDiv.className = 'diff-expected';
            expectedDiv.innerHTML =
              '<span class="diff-label diff-label-expected">− Expected</span>' +
              escapeHtml(formatValue(result.error.expected));

            const actualDiv = document.createElement('div');
            actualDiv.className = 'diff-actual';
            actualDiv.innerHTML =
              '<span class="diff-label diff-label-actual">+ Actual</span>' +
              escapeHtml(formatValue(result.error.actual));

            diffSide.appendChild(expectedDiv);
            diffSide.appendChild(actualDiv);
            diffContainer.appendChild(diffSide);
            errorDiv.appendChild(diffContainer);
          }

          // Inline diff (text-based, from vitest)
          if (result.error.diff) {
            const inlineDiff = document.createElement('div');
            inlineDiff.className = 'diff-container';
            const inlineDiffHeader = document.createElement('div');
            inlineDiffHeader.className = 'diff-header';
            inlineDiffHeader.textContent = 'Diff';
            inlineDiff.appendChild(inlineDiffHeader);

            const diffContent = document.createElement('div');
            diffContent.style.cssText = 'padding: 8px 12px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap;';
            diffContent.innerHTML = renderDiffText(result.error.diff);
            inlineDiff.appendChild(diffContent);
            errorDiv.appendChild(inlineDiff);
          }

          // Stack trace
          if (result.error.stack) {
            const stackDiv = document.createElement('div');
            stackDiv.className = 'stack-trace';
            stackDiv.innerHTML = renderStackTrace(result.error.stack);
            errorDiv.appendChild(stackDiv);

            // Wire up stack trace links
            stackDiv.querySelectorAll('.stack-link').forEach(link => {
              link.addEventListener('click', () => {
                vscode.postMessage({
                  type: 'openFile',
                  file: link.getAttribute('data-file'),
                  line: parseInt(link.getAttribute('data-line')) || undefined,
                });
              });
            });
          }

          row.appendChild(errorDiv);
        }

        return row;
      }

      // ─── Utilities ─────────────────────────────────────

      function escapeHtml(str) {
        if (str == null) return '';
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      function escapeAttr(str) {
        return escapeHtml(str).replace(/'/g, '&#39;');
      }

      function formatValue(val) {
        if (val === undefined) return 'undefined';
        if (val === null) return 'null';
        if (typeof val === 'string') return '"' + val + '"';
        if (typeof val === 'object') {
          try { return JSON.stringify(val, null, 2); } catch { return String(val); }
        }
        return String(val);
      }

      function renderDiffText(diff) {
        // Color diff lines: - lines red, + lines green, @@ lines blue
        return diff.split('\\n').map(line => {
          if (line.startsWith('-')) {
            return '<span style="color:var(--red);background:var(--diff-remove-bg);display:block;padding:0 4px;">' + escapeHtml(line) + '</span>';
          }
          if (line.startsWith('+')) {
            return '<span style="color:var(--green);background:var(--diff-add-bg);display:block;padding:0 4px;">' + escapeHtml(line) + '</span>';
          }
          if (line.startsWith('@@')) {
            return '<span style="color:var(--blue);display:block;padding:0 4px;">' + escapeHtml(line) + '</span>';
          }
          return '<span style="display:block;padding:0 4px;">' + escapeHtml(line) + '</span>';
        }).join('');
      }

      function renderStackTrace(stack) {
        // Parse stack trace and make file paths clickable
        return stack.split('\\n').map(line => {
          // Match patterns like "at Something (C:/path/file.ts:42:15)" or "❯ file.ts:42:15"
          const match = line.match(/(?:at\\s+.*?\\(|❯\\s*|at\\s+)([A-Za-z]:[^\\\\/].*?|\\/.+?):(\\ d+)(?::(\\d+))?\\)?/);
          if (match) {
            const [, file, lineNum] = match;
            const fileName = file.split(/[\\\\/]/).pop();
            return escapeHtml(line).replace(
              escapeHtml(file + ':' + lineNum),
              '<a class="stack-link" data-file="' + escapeAttr(file) + '" data-line="' + lineNum + '">' +
              escapeHtml(file + ':' + lineNum) + '</a>'
            );
          }
          return escapeHtml(line);
        }).join('\\n');
      }

      // ─── Signal ready ──────────────────────────────────
      vscode.postMessage({ type: 'ready' });
    `;
  }
}
