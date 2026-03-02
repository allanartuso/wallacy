/**
 * ConsoleLogEvalCommand — "Wallacy: Evaluate Console Logs" command.
 *
 * When triggered on the active editor, this command:
 *   1. Scans the file for `console.log/warn/error/info/debug` calls
 *   2. Instruments the code and executes it in a child process
 *   3. Captures each console output with its source location
 *   4. Applies inline decorations (truncated text after the line)
 *   5. Shows full output on hover
 *   6. Sends all entries to the webview console pane
 *
 * This gives a Quokka-like experience: see console output inline
 * without leaving the editor.
 */

import * as path from 'path';
import Container, { Service } from 'typedi';
import * as vscode from 'vscode';
import { ConsoleLogInterceptor } from './console-log-interceptor';
import { EditorDecorations } from './editor-decorations';
import { VsCodeService } from './vs-code.service';
import { TestResultsPanel } from './webview';

@Service()
export class ConsoleLogEvalCommand {
  private readonly vsCodeService = Container.get(VsCodeService);
  private readonly interceptor = Container.get(ConsoleLogInterceptor);
  private readonly editorDecorations = Container.get(EditorDecorations);
  private readonly testResultsPanel = Container.get(TestResultsPanel);

  /** Disposable for the save-on-type listener */
  private onChangeDisposable: vscode.Disposable | null = null;
  /** Disposable for the active editor change listener */
  private onEditorChangeDisposable: vscode.Disposable | null = null;
  /** Debounce timer for auto-eval on change */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether live mode is enabled */
  private liveMode = false;
  /** Status bar item to show live mode status */
  private statusBarItem: vscode.StatusBarItem | null = null;

  /**
   * Evaluate console logs in the active editor (one-shot).
   */
  async evaluate(): Promise<void> {
    const editor = this.vsCodeService.activeTextEditor;
    if (!editor) {
      this.vsCodeService.showErrorMessage('No active editor found');
      return;
    }

    const document = editor.document;
    const filePath = document.uri.fsPath;
    const source = document.getText();

    if (!this.interceptor.hasConsoleCalls(source)) {
      this.vsCodeService.showInformationMessage(
        'No console.log/warn/error/info/debug calls found in this file.',
      );
      return;
    }

    // Determine working directory
    const workspaceFolder = this.vsCodeService.getWorkspaceFolder(document.uri);
    const workingDir = workspaceFolder?.uri.fsPath ?? path.dirname(filePath);

    this.vsCodeService.appendLine(
      `[ConsoleLogEval] Evaluating console logs in: ${path.basename(filePath)}`,
    );

    try {
      // Clear previous decorations for this file
      this.editorDecorations.clearDecorations();

      const logs = await this.interceptor.interceptConsoleLogs(
        filePath,
        source,
        workingDir,
      );

      this.vsCodeService.appendLine(
        `[ConsoleLogEval] Captured ${logs.length} console output(s)`,
      );

      if (logs.length === 0) {
        this.vsCodeService.showInformationMessage(
          'Console logs evaluated — no output captured.',
        );
        return;
      }

      // Apply inline decorations in the editor
      this.editorDecorations.applyConsoleLogs(filePath, logs);

      // Send to webview console pane
      this.testResultsPanel.createOrShow();
      this.testResultsPanel.notifyRunStarted(filePath);
      for (const entry of logs) {
        this.testResultsPanel.notifyConsoleLog(entry);
      }
      this.testResultsPanel.notifyConsoleLogsUpdate(logs);

      const errorCount = logs.filter((l) => l.stream === 'stderr').length;
      const msg =
        `Evaluated ${logs.length} console output(s)` +
        (errorCount > 0 ? ` (${errorCount} error/warning)` : '');
      this.vsCodeService.setStatusBarMessage('$(check) ' + msg, 3000);
    } catch (err: any) {
      this.vsCodeService.showErrorMessage(
        `Console log evaluation failed: ${err.message}`,
      );
    }
  }

  /**
   * Toggle live evaluation mode — automatically re-evaluate when the file changes.
   */
  toggleLiveMode(): void {
    if (this.liveMode) {
      this.disableLiveMode();
      this.vsCodeService.showInformationMessage(
        'Wallacy: Live console evaluation disabled.',
      );
    } else {
      this.enableLiveMode();
      this.vsCodeService.showInformationMessage(
        'Wallacy: Live console evaluation enabled. Console output will update as you type.',
      );
      // Run immediately
      this.evaluate();
    }
  }

  private enableLiveMode(): void {
    this.liveMode = true;

    // Create status bar item
    if (!this.statusBarItem) {
      this.statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100,
      );
    }
    this.statusBarItem.text = '$(eye) Wallacy Live';
    this.statusBarItem.tooltip =
      'Wallacy live console evaluation is active. Click to disable.';
    this.statusBarItem.command = 'wallacy.toggleLiveConsole';
    this.statusBarItem.show();

    // Listen for document changes (debounced)
    this.onChangeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || e.document !== editor.document) {
        return;
      }
      this.scheduleEval();
    });

    // Listen for active editor changes
    this.onEditorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (editor) {
          this.scheduleEval();
        }
      },
    );
  }

  private disableLiveMode(): void {
    this.liveMode = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.onChangeDisposable) {
      this.onChangeDisposable.dispose();
      this.onChangeDisposable = null;
    }
    if (this.onEditorChangeDisposable) {
      this.onEditorChangeDisposable.dispose();
      this.onEditorChangeDisposable = null;
    }
    if (this.statusBarItem) {
      this.statusBarItem.hide();
    }
  }

  private scheduleEval(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.evaluate();
    }, 800); // 800ms debounce
  }

  dispose(): void {
    this.disableLiveMode();
    if (this.statusBarItem) {
      this.statusBarItem.dispose();
      this.statusBarItem = null;
    }
  }
}
