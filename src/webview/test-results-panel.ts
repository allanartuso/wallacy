/**
 * TestResultsPanel -- VS Code Webview panel for test results, diffs & console.
 *
 * Features:
 * - ANSI escape code parser for proper diff coloring
 * - Remembers last-run file so Re-run works from panel focus
 * - Console log display with ANSI rendering and source links
 * - Clickable stack traces with file:line navigation
 */

import {Service} from "typedi";
import * as vscode from "vscode";
import type {CollectedResults, ConsoleLogEntry, SmartStartResult, TestInfo, TestResult} from "../shared-types";

// -- Message types: Extension -> Webview

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

// -- Message types: Webview -> Extension

export type WebviewIncomingMessage =
  | {type: "openFile"; file: string; line?: number}
  | {type: "rerun"}
  | {type: "ready"};

// -- Panel

@Service()
export class TestResultsPanel {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private pendingMessages: WebviewMessage[] = [];
  private webviewReady = false;

  /** File path used for the last run — allows Re-run even when panel has focus. */
  private lastRunFile: string | undefined;

  /** Callback for when the user clicks Re-run. Receives the remembered file path. */
  onRerunRequested?: (filePath: string) => void;

  // -- Lifecycle

  createOrShow(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "wallacy.testResults",
      "Wallacy \u2014 Test Results",
      {viewColumn: vscode.ViewColumn.Beside, preserveFocus: true},
      {enableScripts: true, retainContextWhenHidden: true, localResourceRoots: []},
    );

    this.panel.iconPath = new vscode.ThemeIcon("beaker");
    this.panel.webview.html = this.getHtmlContent();
    this.webviewReady = false;

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewIncomingMessage) => {
        switch (msg.type) {
          case "openFile":
            this.handleOpenFile(msg.file, msg.line);
            break;
          case "rerun":
            if (this.lastRunFile) {
              this.onRerunRequested?.(this.lastRunFile);
            }
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

  // -- Messaging

  postMessage(message: WebviewMessage): void {
    if (this.webviewReady && this.panel) {
      this.panel.webview.postMessage(message);
    } else {
      this.pendingMessages.push(message);
    }
  }

  // -- Convenience helpers

  notifyRunStarted(file: string): void {
    this.lastRunFile = file;
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
      data: {results: collected.results, duration: collected.duration, passed, failed, skipped},
    });
  }

  notifyConsoleLog(entry: ConsoleLogEntry): void {
    this.postMessage({type: "consoleLog", data: entry});
  }

  dispose(): void {
    this.panel?.dispose();
  }

  // -- Private

  private flushPendingMessages(): void {
    for (const msg of this.pendingMessages) {
      this.panel?.webview.postMessage(msg);
    }
    this.pendingMessages = [];
  }

  private handleOpenFile(file: string, line?: number): void {
    const uri = vscode.Uri.file(file);
    const opts: vscode.TextDocumentShowOptions = {viewColumn: vscode.ViewColumn.One, preserveFocus: false};
    if (line !== undefined && line > 0) {
      const pos = new vscode.Position(line - 1, 0);
      opts.selection = new vscode.Range(pos, pos);
    }
    vscode.window.showTextDocument(uri, opts);
  }

  // -- HTML

  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wallacy</title>
<style>${this.getCss()}</style>
</head>
<body>
<header id="header">
  <div class="hdr-left">
    <span class="logo">\u{1F9EA}</span>
    <h1>Wallacy</h1>
    <span id="badge-project" class="badge hidden"></span>
    <span id="badge-framework" class="badge badge-fw hidden"></span>
  </div>
  <div class="hdr-right">
    <button id="btn-rerun" class="btn btn-primary hidden" title="Re-run tests">
      \u25B6 Re-run
    </button>
  </div>
</header>
<section id="summary" class="summary hidden">
  <div class="sum-item sum-pass"><span class="si">\u2713</span> <b id="n-pass">0</b> passed</div>
  <div class="sum-item sum-fail"><span class="si">\u2717</span> <b id="n-fail">0</b> failed</div>
  <div class="sum-item sum-skip"><span class="si">\u25CB</span> <b id="n-skip">0</b> skipped</div>
  <div class="sum-item sum-time"><span class="si">\u23F1</span> <b id="n-time">0</b>ms</div>
</section>
<nav id="tabs" class="tabs">
  <button class="tab active" data-tab="results">Results</button>
  <button class="tab" data-tab="console">Console <span id="console-count" class="tab-badge hidden">0</span></button>
</nav>
<main id="pane-results" class="pane active">
  <div id="spinner" class="spinner-wrap">
    <div class="spinner"></div>
    <p id="spinner-text">Resolving project\u2026</p>
  </div>
  <div id="results-list" class="results-list hidden"></div>
  <div id="empty" class="empty hidden">
    <p>No test results yet. Run <strong>Wallacy: Smart Start</strong> on a test file.</p>
  </div>
</main>
<main id="pane-console" class="pane">
  <div id="console-list" class="console-list"></div>
  <div id="console-empty" class="empty"><p>No console output captured.</p></div>
</main>
<script>${this.getJs()}</script>
</body>
</html>`;
  }

  // -- CSS

  private getCss(): string {
    return `:root {
  --bg:       var(--vscode-editor-background);
  --fg:       var(--vscode-editor-foreground);
  --border:   var(--vscode-panel-border, var(--vscode-widget-border, #333));
  --card:     var(--vscode-editorWidget-background, var(--vscode-sideBar-background, #1e1e1e));
  --hover:    var(--vscode-list-hoverBackground, #2a2d2e);
  --green:    var(--vscode-testing-iconPassed, #73c991);
  --red:      var(--vscode-testing-iconFailed, #f14c4c);
  --yellow:   var(--vscode-testing-iconSkipped, #cca700);
  --blue:     var(--vscode-textLink-foreground, #3794ff);
  --muted:    var(--vscode-descriptionForeground, #888);
  --diff-ins: var(--vscode-diffEditor-insertedTextBackground, rgba(115,201,145,.15));
  --diff-del: var(--vscode-diffEditor-removedTextBackground,  rgba(241,76,76,.15));
  --mono:     var(--vscode-editor-font-family, 'Consolas','Courier New',monospace);
  --fs:       var(--vscode-editor-font-size, 13px);
  --r:        6px;
}
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:var(--vscode-font-family,-apple-system,BlinkMacSystemFont,sans-serif);
  font-size:var(--fs);color:var(--fg);background:var(--bg);
  line-height:1.5;overflow-x:hidden;
}
header{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 16px;border-bottom:1px solid var(--border);background:var(--card);
}
.hdr-left,.hdr-right{display:flex;align-items:center;gap:8px}
.logo{font-size:20px}
h1{font-size:15px;font-weight:600}
.badge{
  font-size:11px;padding:2px 8px;border-radius:10px;
  background:var(--vscode-badge-background,#4d4d4d);
  color:var(--vscode-badge-foreground,#fff);white-space:nowrap;
}
.badge-fw{background:var(--blue);color:#fff}
.btn{
  display:flex;align-items:center;gap:4px;padding:4px 12px;
  border:none;border-radius:var(--r);font-size:12px;cursor:pointer;
  color:var(--fg);background:var(--vscode-button-secondaryBackground,#333);
}
.btn:hover{background:var(--vscode-button-secondaryHoverBackground,#444)}
.btn-primary{
  background:var(--vscode-button-background,#0e639c);
  color:var(--vscode-button-foreground,#fff);
}
.btn-primary:hover{background:var(--vscode-button-hoverBackground,#1177bb)}
.summary{
  display:flex;align-items:center;gap:20px;
  padding:8px 16px;border-bottom:1px solid var(--border);
  background:var(--card);font-size:13px;
}
.sum-item{display:flex;align-items:center;gap:4px}
.si{font-size:14px}
.sum-pass .si{color:var(--green)}
.sum-fail .si{color:var(--red)}
.sum-skip .si{color:var(--yellow)}
.sum-time .si{color:var(--muted)}
.tabs{
  display:flex;border-bottom:1px solid var(--border);
  background:var(--card);padding:0 12px;
}
.tab{
  padding:8px 16px;border:none;background:none;color:var(--muted);
  font-size:13px;cursor:pointer;border-bottom:2px solid transparent;
  transition:all .15s;
}
.tab:hover{color:var(--fg)}
.tab.active{color:var(--fg);border-bottom-color:var(--blue)}
.tab-badge{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:18px;height:18px;margin-left:4px;padding:0 5px;
  border-radius:9px;font-size:10px;
  background:var(--vscode-badge-background,#4d4d4d);
  color:var(--vscode-badge-foreground,#fff);
}
.pane{display:none;padding:12px 16px}
.pane.active{display:block}
.spinner-wrap{
  display:flex;flex-direction:column;align-items:center;
  gap:12px;padding:40px;color:var(--muted);
}
.spinner{
  width:28px;height:28px;border:3px solid var(--border);
  border-top-color:var(--blue);border-radius:50%;
  animation:spin .8s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{padding:40px;text-align:center;color:var(--muted)}
.results-list{display:flex;flex-direction:column;gap:4px}
.file-group{margin-bottom:14px}
.fg-header{
  display:flex;align-items:center;gap:8px;
  padding:6px 0;font-weight:600;font-size:13px;
  border-bottom:1px solid var(--border);margin-bottom:6px;
}
.fg-name{cursor:pointer;color:var(--blue)}
.fg-name:hover{text-decoration:underline}
.fg-stats{margin-left:auto;font-size:11px;color:var(--muted);font-weight:400}
.test-row{
  display:flex;flex-direction:column;border-radius:var(--r);
  background:var(--card);overflow:hidden;
  border:1px solid transparent;transition:border-color .15s;
}
.test-row:hover{border-color:var(--border)}
.tr-header{
  display:flex;align-items:center;gap:8px;
  padding:8px 12px;cursor:pointer;user-select:none;
}
.status-icon{
  flex-shrink:0;width:20px;height:20px;
  display:flex;align-items:center;justify-content:center;
  border-radius:50%;font-size:12px;font-weight:700;
}
.si-pass{color:var(--green);background:rgba(115,201,145,.1)}
.si-fail{color:var(--red);background:rgba(241,76,76,.1)}
.si-skip{color:var(--yellow);background:rgba(204,167,0,.1)}
.test-name{flex:1;font-weight:500}
.test-suite{color:var(--muted);font-size:12px;margin-right:4px}
.test-dur{color:var(--muted);font-size:12px;white-space:nowrap}
.test-link{
  color:var(--blue);font-size:11px;cursor:pointer;
  white-space:nowrap;text-decoration:none;
}
.test-link:hover{text-decoration:underline}
.test-error{display:none;padding:0 12px 12px}
.test-row.expanded .test-error{display:block}
.err-msg{
  font-family:var(--mono);font-size:12px;padding:8px 12px;
  background:var(--diff-del);border-radius:var(--r);
  white-space:pre-wrap;word-break:break-word;
  margin-bottom:8px;border-left:3px solid var(--red);
}
.diff-box{
  font-family:var(--mono);font-size:12px;border-radius:var(--r);
  overflow:hidden;border:1px solid var(--border);margin-bottom:8px;
}
.diff-title{
  padding:6px 12px;background:var(--card);
  border-bottom:1px solid var(--border);
  font-weight:600;font-size:11px;color:var(--muted);
  text-transform:uppercase;letter-spacing:.5px;
}
.diff-cols{display:flex}
.diff-col{
  flex:1;padding:8px 12px;white-space:pre-wrap;
  word-break:break-word;min-width:0;overflow-x:auto;
}
.diff-exp{background:var(--diff-del);border-right:1px solid var(--border)}
.diff-act{background:var(--diff-ins)}
.diff-lbl{
  display:block;font-size:10px;font-weight:600;
  text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;
}
.diff-lbl-exp{color:var(--red)}
.diff-lbl-act{color:var(--green)}
.ansi-diff{
  padding:8px 12px;white-space:pre-wrap;word-break:break-word;
  font-family:var(--mono);font-size:12px;line-height:1.6;
}
.ansi-diff .line{display:block;padding:1px 6px;border-radius:3px;margin:0 -6px}
.ansi-diff .line-add{background:var(--diff-ins);color:var(--green)}
.ansi-diff .line-del{background:var(--diff-del);color:var(--red)}
.ansi-diff .line-hunk{color:var(--blue);font-weight:600;opacity:.8}
.ansi-diff .line-ctx{opacity:.7}
.stack{
  font-family:var(--mono);font-size:11px;color:var(--muted);
  padding:8px 12px;background:var(--card);border-radius:var(--r);
  white-space:pre-wrap;word-break:break-word;
  max-height:200px;overflow-y:auto;border:1px solid var(--border);
}
.stack-link{color:var(--blue);cursor:pointer;text-decoration:none}
.stack-link:hover{text-decoration:underline}
.console-list{display:flex;flex-direction:column;gap:2px}
.con-entry{
  font-family:var(--mono);font-size:12px;
  padding:6px 12px;border-radius:3px;
  white-space:pre-wrap;word-break:break-word;
}
.con-stdout{color:var(--fg)}
.con-stderr{color:var(--red);background:var(--diff-del)}
.con-src{color:var(--blue);font-size:11px;cursor:pointer;margin-right:6px}
.con-src:hover{text-decoration:underline}
.hidden{display:none !important}
::-webkit-scrollbar{width:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,#424242);border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground,#555)}`;
  }

  // -- JavaScript

  private getJs(): string {
    return "\"use strict\";\nvar vscode = acquireVsCodeApi();\n\n/* ANSI Parser */\nvar ANSI = (function() {\n  var SGR = {\n    0:'', 1:'font-weight:bold', 2:'opacity:.6', 3:'font-style:italic',\n    4:'text-decoration:underline', 22:'', 23:'', 24:'',\n    30:'color:#1e1e1e', 31:'color:var(--red)', 32:'color:var(--green)',\n    33:'color:var(--yellow)', 34:'color:var(--blue)', 35:'color:#c586c0',\n    36:'color:#4ec9b0', 37:'color:var(--fg)', 39:'',\n    90:'color:#888', 91:'color:#f48771', 92:'color:#89d185',\n    93:'color:#e5e510', 94:'color:#6796e6', 95:'color:#d670d6',\n    96:'color:#2bc1c4', 97:'color:#e5e5e5'\n  };\n  function strip(s) {\n    if (!s) return '';\n    return s.replace(/\\x1b\\[[0-9;]*m/g, '');\n  }\n  function toHtml(s) {\n    if (!s) return '';\n    var parts = [], open = 0;\n    var re = /\\x1b\\[([0-9;]*)m/g;\n    var last = 0, m;\n    while ((m = re.exec(s)) !== null) {\n      if (m.index > last) parts.push(esc(s.slice(last, m.index)));\n      last = m.index + m[0].length;\n      var codes = m[1].split(';');\n      for (var i = 0; i < codes.length; i++) {\n        var c = parseInt(codes[i], 10);\n        if (c === 0 || c === 39 || c === 22 || c === 23 || c === 24) {\n          while (open > 0) { parts.push('</span>'); open--; }\n        } else if (SGR[c]) {\n          parts.push('<span style=\"' + SGR[c] + '\">');\n          open++;\n        }\n      }\n    }\n    if (last < s.length) parts.push(esc(s.slice(last)));\n    while (open > 0) { parts.push('</span>'); open--; }\n    return parts.join('');\n  }\n  return { strip: strip, toHtml: toHtml };\n})();\n\n/* Utilities */\nfunction esc(s) {\n  if (s == null) return '';\n  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');\n}\nfunction escAttr(s) { return esc(s).replace(/'/g,'&#39;'); }\nfunction basename(p) { return String(p).split(/[\\\\\\\\/]/).pop() || p; }\nfunction fmtVal(v) {\n  if (v === undefined) return 'undefined';\n  if (v === null) return 'null';\n  if (typeof v === 'string') return '\"' + v + '\"';\n  if (typeof v === 'object') { try { return JSON.stringify(v, null, 2); } catch(e) { return String(v); } }\n  return String(v);\n}\n\n/* State */\nvar allResults = [];\nvar consoleLogs = [];\n\n/* DOM refs */\nfunction $(sel) { return document.querySelector(sel); }\nfunction $$(sel) { return document.querySelectorAll(sel); }\nvar spinner      = $('#spinner');\nvar spinnerText  = $('#spinner-text');\nvar resultsList  = $('#results-list');\nvar emptyState   = $('#empty');\nvar summaryBar   = $('#summary');\nvar badgeProject = $('#badge-project');\nvar badgeFw      = $('#badge-framework');\nvar btnRerun     = $('#btn-rerun');\nvar consoleListEl= $('#console-list');\nvar consoleEmpty = $('#console-empty');\nvar consoleCount = $('#console-count');\n\n/* Tab switching */\n$$('.tab').forEach(function(t) {\n  t.addEventListener('click', function() {\n    $$('.tab').forEach(function(x) { x.classList.remove('active'); });\n    $$('.pane').forEach(function(x) { x.classList.remove('active'); });\n    t.classList.add('active');\n    $('#pane-' + t.dataset.tab).classList.add('active');\n  });\n});\n\n/* Re-run */\nbtnRerun.addEventListener('click', function() { vscode.postMessage({ type: 'rerun' }); });\n\n/* Message handler */\nwindow.addEventListener('message', function(e) {\n  var m = e.data;\n  switch(m.type) {\n    case 'clear':           onClear(); break;\n    case 'runStarted':      onRunStarted(m.data); break;\n    case 'resolution':      onResolution(m.data); break;\n    case 'testsDiscovered': onDiscover(m.data); break;\n    case 'testResult':      onResult(m.data); break;\n    case 'runComplete':     onComplete(m.data); break;\n    case 'consoleLog':      onConsole(m.data); break;\n  }\n});\n\n/* Handlers */\nfunction onClear() {\n  allResults = []; consoleLogs = [];\n  resultsList.innerHTML = ''; resultsList.classList.add('hidden');\n  consoleListEl.innerHTML = '';\n  consoleEmpty.classList.remove('hidden');\n  consoleCount.classList.add('hidden');\n  summaryBar.classList.add('hidden');\n  emptyState.classList.add('hidden');\n  spinner.classList.remove('hidden');\n  spinnerText.textContent = 'Resolving project\\u2026';\n  badgeProject.classList.add('hidden');\n  badgeFw.classList.add('hidden');\n  btnRerun.classList.add('hidden');\n}\n\nfunction onRunStarted(d) {\n  onClear();\n  spinnerText.textContent = 'Resolving project for ' + basename(d.file) + '\\u2026';\n}\n\nfunction onResolution(d) {\n  badgeProject.textContent = d.projectName; badgeProject.classList.remove('hidden');\n  badgeFw.textContent = d.testFramework;    badgeFw.classList.remove('hidden');\n  spinnerText.textContent = 'Discovering tests\\u2026';\n}\n\nfunction onDiscover(tests) {\n  spinnerText.textContent = 'Running ' + tests.length + ' test(s)\\u2026';\n}\n\nfunction onResult(r) {\n  allResults.push(r);\n  spinner.classList.add('hidden');\n  resultsList.classList.remove('hidden');\n  emptyState.classList.add('hidden');\n  refreshSummary();\n  renderResults();\n}\n\nfunction onComplete(d) {\n  spinner.classList.add('hidden');\n  btnRerun.classList.remove('hidden');\n  if (!allResults.length && d.results && d.results.length) allResults = d.results;\n  refreshSummary();\n  renderResults();\n  if (!allResults.length) { resultsList.classList.add('hidden'); emptyState.classList.remove('hidden'); }\n}\n\nfunction onConsole(entry) {\n  consoleLogs.push(entry);\n  consoleEmpty.classList.add('hidden');\n  consoleCount.textContent = consoleLogs.length;\n  consoleCount.classList.remove('hidden');\n  appendConsoleEntry(entry);\n}\n\n/* Summary */\nfunction refreshSummary() {\n  var p=0, f=0, s=0, t=0;\n  for (var i=0; i<allResults.length; i++) {\n    if (allResults[i].status === 'passed') p++;\n    else if (allResults[i].status === 'failed') f++;\n    else if (allResults[i].status === 'skipped') s++;\n    t += (allResults[i].duration || 0);\n  }\n  $('#n-pass').textContent = p;\n  $('#n-fail').textContent = f;\n  $('#n-skip').textContent = s;\n  $('#n-time').textContent = Math.round(t);\n  summaryBar.classList.remove('hidden');\n}\n\n/* Results rendering */\nfunction renderResults() {\n  var groups = {};\n  for (var i = 0; i < allResults.length; i++) {\n    var r = allResults[i];\n    var f = r.file || 'unknown';\n    if (!groups[f]) groups[f] = [];\n    groups[f].push(r);\n  }\n  resultsList.innerHTML = '';\n  var files = Object.keys(groups);\n  for (var fi = 0; fi < files.length; fi++) {\n    var file = files[fi];\n    var tests = groups[file];\n    var g = document.createElement('div'); g.className = 'file-group';\n    var fp=0, ff=0, fsk=0;\n    for (var j=0;j<tests.length;j++){\n      if(tests[j].status==='passed')fp++;\n      else if(tests[j].status==='failed')ff++;\n      else fsk++;\n    }\n    g.innerHTML =\n      '<div class=\"fg-header\">' +\n        '<span>\\uD83D\\uDCC4</span>' +\n        '<span class=\"fg-name\" data-file=\"'+escAttr(file)+'\">'+esc(basename(file))+'</span>' +\n        '<span class=\"fg-stats\">' +\n          (fp ? '<span style=\"color:var(--green)\">'+fp+' \\u2713</span> ' : '') +\n          (ff ? '<span style=\"color:var(--red)\">'+ff+' \\u2717</span> ' : '') +\n          (fsk? '<span style=\"color:var(--yellow)\">'+fsk+' \\u25CB</span>' : '') +\n        '</span>' +\n      '</div>';\n    var nameEl = g.querySelector('.fg-name');\n    nameEl.addEventListener('click', (function(f) {\n      return function() { vscode.postMessage({type:'openFile',file:f}); };\n    })(file));\n    for (var k=0; k<tests.length; k++) {\n      g.appendChild(buildTestRow(tests[k]));\n    }\n    resultsList.appendChild(g);\n  }\n}\n\n/* Test row */\nfunction buildTestRow(r) {\n  var row = document.createElement('div');\n  row.className = 'test-row';\n  if (r.status === 'failed') row.classList.add('expanded');\n\n  var hdr = document.createElement('div'); hdr.className = 'tr-header';\n  var ico = document.createElement('div');\n  ico.className = 'status-icon ' + (r.status==='passed'?'si-pass':r.status==='failed'?'si-fail':'si-skip');\n  ico.textContent = r.status==='passed'?'\\u2713':r.status==='failed'?'\\u2717':'\\u25CB';\n\n  var nameSpan = document.createElement('span'); nameSpan.className = 'test-name';\n  if (r.suite && r.suite.length) {\n    var s = document.createElement('span'); s.className = 'test-suite';\n    s.textContent = r.suite.join(' \\u203A ') + ' \\u203A ';\n    nameSpan.appendChild(s);\n  }\n  nameSpan.appendChild(document.createTextNode(r.name));\n\n  var dur = document.createElement('span'); dur.className = 'test-dur';\n  dur.textContent = (r.duration||0) + 'ms';\n\n  hdr.appendChild(ico); hdr.appendChild(nameSpan); hdr.appendChild(dur);\n\n  if (r.line && r.file) {\n    var lnk = document.createElement('a'); lnk.className = 'test-link';\n    lnk.textContent = ':' + r.line; lnk.title = 'Open in editor';\n    lnk.addEventListener('click', (function(file, line) {\n      return function(e) {\n        e.stopPropagation();\n        vscode.postMessage({type:'openFile',file:file,line:line});\n      };\n    })(r.file, r.line));\n    hdr.appendChild(lnk);\n  }\n  hdr.addEventListener('click', function() { row.classList.toggle('expanded'); });\n  row.appendChild(hdr);\n\n  if (r.error) {\n    var errDiv = document.createElement('div'); errDiv.className = 'test-error';\n\n    var msgDiv = document.createElement('div'); msgDiv.className = 'err-msg';\n    msgDiv.textContent = ANSI.strip(r.error.message || 'Unknown error');\n    errDiv.appendChild(msgDiv);\n\n    if (r.error.expected !== undefined || r.error.actual !== undefined) {\n      var box = document.createElement('div'); box.className = 'diff-box';\n      var dtitle = document.createElement('div'); dtitle.className = 'diff-title';\n      dtitle.textContent = 'Expected vs Actual';\n      box.appendChild(dtitle);\n      var cols = document.createElement('div'); cols.className = 'diff-cols';\n      var expDiv = document.createElement('div'); expDiv.className = 'diff-col diff-exp';\n      expDiv.innerHTML = '<span class=\"diff-lbl diff-lbl-exp\">\\u2212 Expected</span>' + esc(fmtVal(r.error.expected));\n      var actDiv = document.createElement('div'); actDiv.className = 'diff-col diff-act';\n      actDiv.innerHTML = '<span class=\"diff-lbl diff-lbl-act\">+ Actual</span>' + esc(fmtVal(r.error.actual));\n      cols.appendChild(expDiv); cols.appendChild(actDiv);\n      box.appendChild(cols);\n      errDiv.appendChild(box);\n    }\n\n    if (r.error.diff) {\n      errDiv.appendChild(renderAnsiDiff(r.error.diff));\n    }\n\n    if (r.error.stack) {\n      var stDiv = document.createElement('div'); stDiv.className = 'stack';\n      stDiv.innerHTML = renderStack(r.error.stack);\n      var links = stDiv.querySelectorAll('.stack-link');\n      for (var li = 0; li < links.length; li++) {\n        links[li].addEventListener('click', (function(a) {\n          return function() {\n            vscode.postMessage({\n              type:'openFile',\n              file: a.getAttribute('data-file'),\n              line: parseInt(a.getAttribute('data-line'))||undefined\n            });\n          };\n        })(links[li]));\n      }\n      errDiv.appendChild(stDiv);\n    }\n\n    row.appendChild(errDiv);\n  }\n  return row;\n}\n\n/* ANSI diff renderer */\nfunction renderAnsiDiff(raw) {\n  var box = document.createElement('div'); box.className = 'diff-box';\n  var title = document.createElement('div'); title.className = 'diff-title';\n  title.textContent = 'Diff';\n  box.appendChild(title);\n  var content = document.createElement('div'); content.className = 'ansi-diff';\n  var clean = ANSI.strip(raw);\n  var rawLines = raw.split('\\n');\n  var cleanLines = clean.split('\\n');\n  for (var i = 0; i < rawLines.length; i++) {\n    var cl = (cleanLines[i] || '').trimStart();\n    var rl = rawLines[i] || '';\n    var span = document.createElement('span');\n    span.className = 'line';\n    if (cl.startsWith('- Expected') || cl.startsWith('+ Received')) {\n      span.classList.add(cl.startsWith('-') ? 'line-del' : 'line-add');\n    } else if (cl.startsWith('@@')) {\n      span.classList.add('line-hunk');\n    } else if (cl.startsWith('+')) {\n      span.classList.add('line-add');\n    } else if (cl.startsWith('-')) {\n      span.classList.add('line-del');\n    } else {\n      span.classList.add('line-ctx');\n    }\n    span.innerHTML = ANSI.toHtml(rl);\n    content.appendChild(span);\n  }\n  box.appendChild(content);\n  return box;\n}\n\n/* Stack trace renderer */\nfunction renderStack(stack) {\n  var clean = ANSI.strip(stack);\n  var lines = clean.split('\\n');\n  var out = [];\n  for (var i = 0; i < lines.length; i++) {\n    var line = lines[i];\n    var m = line.match(/(?:at\\s+.*?\\(|\\u276F\\s*|at\\s+)([A-Za-z]:[\\\\\\/].+?|\\/.+?):(\\d+)(?::\\d+)?\\)?/);\n    if (m) {\n      var file = m[1], ln = m[2];\n      var escaped = esc(line);\n      var target = esc(file + ':' + ln);\n      out.push(escaped.replace(target,\n        '<a class=\"stack-link\" data-file=\"'+escAttr(file)+'\" data-line=\"'+ln+'\">'+target+'</a>'\n      ));\n    } else {\n      out.push(esc(line));\n    }\n  }\n  return out.join('\\n');\n}\n\n/* Console entry */\nfunction appendConsoleEntry(entry) {\n  var el = document.createElement('div');\n  el.className = 'con-entry con-' + entry.stream;\n  var html = '';\n  if (entry.file) {\n    var fn = basename(entry.file);\n    var ln = entry.line ? ':' + entry.line : '';\n    html += '<span class=\"con-src\" data-file=\"'+escAttr(entry.file)+'\"' +\n            ' data-line=\"'+(entry.line||'')+'\">' +\n            esc(fn + ln) + '</span>';\n  }\n  html += '<span class=\"con-content\">' + ANSI.toHtml(entry.content) + '</span>';\n  el.innerHTML = html;\n  var src = el.querySelector('.con-src');\n  if (src) {\n    src.addEventListener('click', function() {\n      vscode.postMessage({\n        type: 'openFile',\n        file: src.getAttribute('data-file'),\n        line: parseInt(src.getAttribute('data-line')) || undefined\n      });\n    });\n  }\n  consoleListEl.appendChild(el);\n}\n\n/* Signal ready */\nvscode.postMessage({ type: 'ready' });";
  }
}
