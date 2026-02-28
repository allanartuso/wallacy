import * as path from "path";
import Container, {Service} from "typedi";
import * as vscode from "vscode";
import {FileSystemWatcher} from "vscode";
import {EditorDecorations} from "./editor-decorations";
import {IPCClient} from "./ipc-client";
import type {ConsoleLogEntry, SmartStartResult, TestResult} from "./shared-types";
import {SmartStartCallbacks, SmartStartExecutor} from "./smart-start-executor";
import {SmartStartSession} from "./smart-start-session";
import {TestResultCache} from "./test-result-cache";
import {isTestFile} from "./test-utils";
import {VsCodeService} from "./vs-code.service";
import {TestResultsPanel} from "./webview";

@Service()
export class SmartStartCommand {
  private readonly vsCodeService = Container.get(VsCodeService);
  private readonly iPCClient = Container.get(IPCClient);
  private readonly smartStartSession = Container.get(SmartStartSession);
  private readonly smartStartExecutor = Container.get(SmartStartExecutor);
  private readonly testResultsPanel = Container.get(TestResultsPanel);
  private readonly testResultCache = Container.get(TestResultCache);
  private readonly editorDecorations = Container.get(EditorDecorations);

  private pendingSmartStartFile: string | null = null;
  private fileWatcher: FileSystemWatcher | null = null;
  private workspaceRoot: string | null = null;
  private disposed = false;
  private editorChangeDisposable: vscode.Disposable | null = null;

  constructor() {
    this.setupIPCHandlers();
    this.setupEditorChangeListener();
  }

  setupIPCHandlers() {
    // Listen for smart-start responses from the engine
    this.iPCClient.on("smart-start-response", (payload: any) => {
      this.handleSmartStartResponse(payload);
    });
    // Listen for test discovery
    this.iPCClient.on("test-discovery", (payload: any) => {
      this.handleTestDiscovery(payload);
    });
    // Listen for test results
    this.iPCClient.on("test-result", (payload: any) => {
      this.handleTestResult(payload);
    });
    // Listen for test run complete
    this.iPCClient.on("test-run-complete", (payload: any) => {
      this.handleTestRunComplete(payload);
    });
    // Listen for errors
    this.iPCClient.on("error", (payload: any) => {
      this.vsCodeService.appendLine(JSON.stringify(payload));
      this.handleEngineError(payload);
    });
    this.vsCodeService.showInformationMessage("SmartStart has started");
  }

  /**
   * Re-apply editor decorations when the user switches to a tab that has results.
   */
  private setupEditorChangeListener(): void {
    this.editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        this.editorDecorations.refreshForEditor(editor);
      }
    });
  }

  async execute() {
    this.vsCodeService.appendLine("[Extension] Smart Start initiated");

    if (this.disposed) {
      this.vsCodeService.showErrorMessage("SmartStart has been disposed");
      return;
    }

    this.vsCodeService.show(true);

    const editor = this.vsCodeService.activeTextEditor;
    if (!editor) {
      this.vsCodeService.showErrorMessage("No active editor found");
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const workspaceFolder = this.vsCodeService.getWorkspaceFolder(editor.document.uri);

    this.vsCodeService.appendLine("[Extension] Smart Start initiated for: " + editor.document.uri.fsPath);

    if (!workspaceFolder) {
      this.vsCodeService.showErrorMessage("File is not part of a workspace");
      return;
    }

    this.workspaceRoot = workspaceFolder.uri.fsPath;
    this.vsCodeService.appendLine("[Extension] Smart Start workspaceRoot: " + this.workspaceRoot);

    if (!isTestFile(filePath)) {
      this.vsCodeService.showErrorMessage(`${path.basename(filePath)} is not a test file (.test.ts, .spec.ts, etc)`);
      return;
    }

    this.smartStartSession.setWorkspaceRoot(this.workspaceRoot);

    await this.executeForFile(filePath);
  }

  /**
   * Run the full Smart Start pipeline for a specific file.
   * Called by `execute()` (from active editor) and by re-run (from remembered path).
   *
   * @param forceRun If true, skip cache and re-run the tests.
   */
  async executeForFile(filePath: string, forceRun = false) {
    // ─── Clear previous editor decorations ─────────────────
    this.editorDecorations.clearDecorations();

    // ─── Open the test results panel and wire up re-run ────
    this.testResultsPanel.createOrShow();
    this.testResultsPanel.notifyRunStarted(filePath);
    this.testResultsPanel.onRerunRequested = (rememberedFile: string) => {
      this.vsCodeService.appendLine("[Extension] Re-run requested from panel for: " + rememberedFile);
      this.executeForFile(rememberedFile);
    };

    // ─── Check cache first ─────────────────────────────────
    if (!forceRun) {
      const cached = this.testResultCache.lookup(filePath);
      if (cached) {
        const stats = this.testResultCache.getStats();
        this.vsCodeService.appendLine(
          `[Extension] Cache HIT for ${path.basename(filePath)} ` +
            `(hash: ${cached.contentHash.slice(0, 8)}…, hits: ${stats.hits})`,
        );
        this.replayCachedResult(cached);
        return;
      }
      this.vsCodeService.appendLine(`[Extension] Cache miss for ${path.basename(filePath)} — running tests`);
    } else {
      this.vsCodeService.appendLine(`[Extension] Force re-run for ${path.basename(filePath)} — skipping cache`);
    }

    // ─── Drive the full resolution → execution pipeline ────
    this.pendingSmartStartFile = filePath;

    this.vsCodeService.appendLine(`[Extension] Resolving project and framework for: ${path.basename(filePath)}`);

    const consoleLogs: ConsoleLogEntry[] = [];

    const callbacks: SmartStartCallbacks = {
      onResolved: (result) => {
        this.handleSmartStartResponse(result);
        this.testResultsPanel.notifyResolution(result);
      },
      onTestsDiscovered: (tests) => {
        this.handleTestDiscovery(tests);
        this.testResultsPanel.notifyTestsDiscovered(tests);
      },
      onTestResult: (result: TestResult) => {
        this.handleTestResult(result);
        this.testResultsPanel.notifyTestResult(result);
      },
      onRunComplete: (collected) => {
        this.handleTestRunComplete(collected);
        this.testResultsPanel.notifyRunComplete(collected);
      },
      onConsoleLog: (entry) => {
        consoleLogs.push(entry);
        this.testResultsPanel.notifyConsoleLog(entry);
      },
      onError: (error) => {
        this.handleEngineError({message: error.message});
      },
      onLog: (message) => {
        this.vsCodeService.appendLine(message);
      },
    };

    try {
      const executeResult = await this.smartStartExecutor.execute(filePath, callbacks);

      // ─── Store result in cache ─────────────────────────
      this.testResultCache.store(
        filePath,
        executeResult.resolution,
        executeResult.tests,
        executeResult.results,
        executeResult.collected,
        consoleLogs,
      );

      // ─── Apply editor decorations (gutter + inline) ───
      this.editorDecorations.applyTestResults(filePath, executeResult.collected.results);
      if (consoleLogs.length > 0) {
        this.editorDecorations.applyConsoleLogs(filePath, consoleLogs);
      }

      const stats = this.testResultCache.getStats();
      this.vsCodeService.appendLine(
        `[Extension] Smart Start complete — ` +
          `${executeResult.results.length} result(s) from ${executeResult.resolution.project.name} ` +
          `(cached, total entries: ${stats.size})`,
      );
    } catch (error: any) {
      this.vsCodeService.showErrorMessage(`Smart Start failed: ${error.message}`);
    } finally {
      this.pendingSmartStartFile = null;
    }
  }

  /**
   * Reset the test result cache. Called by the "Wallacy: Reset Cache" command.
   */
  resetCache(): void {
    const stats = this.testResultCache.getStats();
    this.testResultCache.reset();
    this.vsCodeService.appendLine(
      `[Extension] Cache reset — cleared ${stats.size} entries ` + `(was ${stats.hits} hits / ${stats.misses} misses)`,
    );
    this.vsCodeService.showInformationMessage(`Wallacy cache cleared (${stats.size} entries removed)`);
  }

  /**
   * Force re-run a specific file, bypassing the cache.
   */
  async forceRerun(): Promise<void> {
    const editor = this.vsCodeService.activeTextEditor;
    if (!editor) {
      this.vsCodeService.showErrorMessage("No active editor found");
      return;
    }
    const filePath = editor.document.uri.fsPath;
    if (!isTestFile(filePath)) {
      this.vsCodeService.showErrorMessage(`${path.basename(filePath)} is not a test file`);
      return;
    }
    this.testResultCache.invalidate(filePath);
    await this.executeForFile(filePath, true);
  }

  /**
   * Replay a cached test run — sends all the same notifications to the webview
   * panel as a real run, but instantly from memory.
   */
  private replayCachedResult(cached: import("./test-result-cache").CachedTestRun): void {
    // Resolution
    this.handleSmartStartResponse(cached.resolution);
    this.testResultsPanel.notifyResolution(cached.resolution);

    // Tests discovered
    this.handleTestDiscovery(cached.tests);
    this.testResultsPanel.notifyTestsDiscovered(cached.tests);

    // Individual test results
    for (const result of cached.results) {
      this.handleTestResult(result);
      this.testResultsPanel.notifyTestResult(result);
    }

    // Console logs
    for (const entry of cached.consoleLogs) {
      this.testResultsPanel.notifyConsoleLog(entry);
    }

    // Run complete
    this.handleTestRunComplete(cached.collected);
    this.testResultsPanel.notifyRunComplete(cached.collected);

    // Notify webview this was a cached result
    this.testResultsPanel.notifyCachedResult(cached.filePath, cached.cachedAt, cached.contentHash);

    // Apply editor decorations from cached data
    this.editorDecorations.applyTestResults(cached.filePath, cached.collected.results);
    if (cached.consoleLogs.length > 0) {
      this.editorDecorations.applyConsoleLogs(cached.filePath, cached.consoleLogs);
    }

    const passed = cached.collected.results.filter((r) => r.status === "passed").length;
    const failed = cached.collected.results.filter((r) => r.status === "failed").length;
    this.vsCodeService.appendLine(
      `[Extension] Replayed cached results for ${path.basename(cached.filePath)} — ` +
        `${passed} passed, ${failed} failed ` +
        `(cached ${new Date(cached.cachedAt).toLocaleTimeString()})`,
    );
  }

  /**
   * Handle smart-start-response from the engine
   */
  private handleSmartStartResponse(payload: SmartStartResult) {
    this.vsCodeService.appendLine(
      `[Extension] Smart Start resolved: ${payload.project.name} (${payload.testFramework})`,
    );

    if (!this.pendingSmartStartFile && this.smartStartSession.isActive()) {
      // Get the file from the current session
      const currentConfig = this.smartStartSession.getCurrentConfig();
      if (currentConfig.file) {
        this.smartStartSession.initializeSession(currentConfig.file.absolutePath, payload);
      }
    } else if (this.pendingSmartStartFile) {
      // Initialize session with the pending file
      this.smartStartSession.initializeSession(this.pendingSmartStartFile, payload);
      this.setupFileWatching();
    }

    // Show project and framework info
    this.vsCodeService.showInformationMessage(`Running tests in ${payload.project.name} (${payload.testFramework})`);
  }

  /**
   * Handle test discovery results
   */
  private handleTestDiscovery(payload: any) {
    const tests = payload as any[];
    this.vsCodeService.appendLine(`[Extension] Discovered ${tests.length} test(s)`);

    if (tests.length > 0) {
      // this.vsCodeService.appendLine(`[Extension] Test files: ${tests.map((t) => path.basename(t.file)).join(", ")}`);
    } else {
      this.vsCodeService.appendLine(`[Extension] No tests discovered`);
    }
  }

  /**
   * Handle individual test results
   */
  private handleTestResult(payload: any) {
    const result = payload as any;
    const statusIcon = result.status === "passed" ? "✓" : result.status === "failed" ? "✗" : "○";
    this.vsCodeService.appendLine(`[Extension] ${statusIcon} ${result.name} (${result.duration}ms)`);

    if (result.status === "failed" && result.error) {
      this.vsCodeService.appendLine(`[Extension] Error: ${result.error.message}`);
    }
  }

  /**
   * Handle test run completion
   */
  private handleTestRunComplete(payload: any) {
    this.vsCodeService.appendLine(`[Extension] Test run complete`);
    this.vsCodeService.setStatusBarMessage("Test run complete", 3000);
  }

  /**
   * Handle engine errors
   */
  private handleEngineError(payload: any) {
    this.vsCodeService.appendLine(`[Extension] Engine error: ${payload.message}`);
    this.vsCodeService.showErrorMessage(`Test Engine error: ${payload.message}`);
  }

  /**
   * Setup file watching for the current test session
   */
  private setupFileWatching() {
    if (!this.workspaceRoot) {
      return;
    }

    // Dispose existing watcher
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }

    // Create a new watcher for all test files
    const testFilePattern = this.vsCodeService.createRelativePattern(
      this.workspaceRoot,
      "**/*.{test,spec}.{ts,js,tsx,jsx,mts,mjs}",
    );

    this.fileWatcher = this.vsCodeService.createFileSystemWatcher(testFilePattern);

    // On file change, send file change notification to engine
    this.fileWatcher.onDidChange((uri) => {
      const filePath = uri.fsPath;
      this.vsCodeService.appendLine(`[Extension] Test file changed: ${path.basename(filePath)}`);

      // Check if this file is part of the same session
      this.executeForFile(filePath);
    });

    this.vsCodeService.appendLine(`[Extension] File watcher started for test files`);
  }

  dispose() {
    this.disposed = true;
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }
    if (this.editorChangeDisposable) {
      this.editorChangeDisposable.dispose();
    }
    this.iPCClient.disconnect();
    this.smartStartSession.clearSession();
    this.smartStartExecutor.dispose();
    this.testResultsPanel.dispose();
    this.editorDecorations.dispose();

    this.vsCodeService.appendLine("[Extension] SmartStartCommand disposed");
  }

  /**
   * Reset the disposed state so the command can be reused after a stop/restart cycle.
   * Called by the extension host when re-activating Smart Start.
   */
  resetDisposed() {
    this.disposed = false;
  }
}
