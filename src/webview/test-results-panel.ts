/**
 * TestResultsPanel -- VS Code Webview panel that hosts the Angular webview-ui.
 *
 * Instead of inline HTML/CSS/JS template strings, this panel loads the
 * pre-built Angular application from `dist/webview-ui/browser/`.
 * Communication uses the official VS Code `postMessage` API.
 */

import * as fs from "fs";
import * as path from "path";
import {Service} from "typedi";
import * as vscode from "vscode";
import type {
  CollectedResults,
  ConsoleLogEntry,
  ExtensionToWebviewMessage,
  SmartStartResult,
  TestInfo,
  TestResult,
  WebviewToExtensionMessage,
} from "../shared-types";

// Re-export message types for backward compatibility
export type {WebviewToExtensionMessage as WebviewIncomingMessage, ExtensionToWebviewMessage as WebviewMessage};

@Service()
export class TestResultsPanel {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private pendingMessages: ExtensionToWebviewMessage[] = [];
  private webviewReady = false;

  /** Resolved once per activation — set via `setExtensionUri()`. */
  private extensionUri: vscode.Uri | undefined;

  /** File path used for the last run — allows Re-run even when panel has focus. */
  private lastRunFile: string | undefined;

  /** Callback for when the user clicks Re-run. Receives the remembered file path. */
  onRerunRequested?: (filePath: string) => void;

  // -- Setup

  /** Must be called once during extension activation with `context.extensionUri`. */
  setExtensionUri(uri: vscode.Uri): void {
    this.extensionUri = uri;
  }

  // -- Lifecycle

  createOrShow(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    if (!this.extensionUri) {
      throw new Error("TestResultsPanel: extensionUri not set. Call setExtensionUri() first.");
    }

    const webviewDistPath = vscode.Uri.joinPath(this.extensionUri, "dist", "webview-ui", "browser");

    this.panel = vscode.window.createWebviewPanel(
      "wallacy.testResults",
      "Wallacy \u2014 Test Results",
      {viewColumn: vscode.ViewColumn.Beside, preserveFocus: true},
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewDistPath],
      },
    );

    this.panel.iconPath = new vscode.ThemeIcon("beaker");
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview, webviewDistPath);
    this.webviewReady = false;

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToExtensionMessage) => {
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

  postMessage(message: ExtensionToWebviewMessage): void {
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
    // Sanitize the entry to avoid circular references from Vitest task objects
    const safeEntry: ConsoleLogEntry = {
      stream: entry.stream,
      content: typeof entry.content === "string" ? entry.content : String(entry.content),
      file: typeof entry.file === "string" ? entry.file : undefined,
      line: typeof entry.line === "number" ? entry.line : undefined,
      timestamp: entry.timestamp,
    };
    this.postMessage({type: "consoleLog", data: safeEntry});
  }

  notifyCachedResult(file: string, cachedAt: number, contentHash: string): void {
    this.postMessage({type: "cachedResult", data: {file, cachedAt, contentHash}});
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

  // -- HTML: Load Angular build output

  /**
   * Reads the Angular-built `index.html` and rewrites all asset references
   * (`<script src="...">`, `<link href="...">`) to use `webview.asWebviewUri()`
   * so the webview can load them.
   */
  private getHtmlForWebview(webview: vscode.Webview, distUri: vscode.Uri): string {
    const indexPath = path.join(distUri.fsPath, "index.html");

    if (!fs.existsSync(indexPath)) {
      return this.getFallbackHtml("Angular webview not built. Run <code>npm run build:webview</code>.");
    }

    let html = fs.readFileSync(indexPath, "utf-8");

    // Remove <base href="/"> — it breaks asset resolution in webview context
    html = html.replace(/<base\s+href="[^"]*"\s*\/?>/i, "");

    // Remove onload inline handlers — CSP blocks them, and the stylesheet
    // would stay at media="print" forever. Switch it to media="all" directly.
    html = html.replace(/\s*media="print"\s*onload="[^"]*"/g, ' media="all"');

    // Rewrite src="xxx" and href="xxx" to webview URIs (skip http/https/data and empty)
    html = html.replace(/(src|href)="(?!https?:|data:)([^"]+)"/g, (_match, attr, file) => {
      // Strip leading "./" or "/"
      const clean = file.replace(/^\.?\//, "");
      if (!clean) {
        return `${attr}="${file}"`;
      }
      const fileUri = vscode.Uri.joinPath(distUri, clean);
      return `${attr}="${webview.asWebviewUri(fileUri)}"`;
    });

    // Inject CSP meta tag just after <head> for security
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'wasm-unsafe-eval'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join("; ");

    html = html.replace(
      /<head(\s[^>]*)?>/i,
      `<head$1>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );

    return html;
  }

  /** Shown when the Angular build output is missing. */
  private getFallbackHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family, sans-serif);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      text-align: center;
      padding: 20px;
    }
    .msg { max-width: 400px; }
    code {
      background: var(--vscode-textCodeBlock-background, #1e1e1e);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
  </style>
</head>
<body>
  <div class="msg"><p>${message}</p></div>
</body>
</html>`;
  }
}
