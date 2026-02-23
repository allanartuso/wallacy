import * as path from "path";
import * as vscode from "vscode";
import { IPCClient } from "./ipc-client";
import { SmartStartSession } from "./smart-start-session";
import { isTestFile } from "./test-utils";
import type { SmartStartResult } from "./shared-types";

export class SmartStartCommand {
  private ipcClient: IPCClient;
  private outputChannel: vscode.OutputChannel;
  private pendingSmartStartFile: string | null = null;
  private engineInitializer: (() => Promise<number>) | null = null;
  private session: SmartStartSession | null = null;
  private fileWatcher: vscode.FileSystemWatcher | null = null;
  private workspaceRoot: string | null = null;
  private disposed = false;

  constructor(
    context: vscode.ExtensionContext,
    client: IPCClient,
    outputChannel: vscode.OutputChannel,
    engineInitializer?: () => Promise<number>,
  ) {
    this.outputChannel = outputChannel;
    this.ipcClient = client;
    this.engineInitializer = engineInitializer || null;

    // Setup IPC listeners for smart start responses
    this.setupIPCHandlers();
  }

  private setupIPCHandlers() {
    // Listen for smart-start responses from the engine
    this.ipcClient.on("smart-start-response", (payload: any) => {
      this.handleSmartStartResponse(payload);
    });

    // Listen for test discovery
    this.ipcClient.on("test-discovery", (payload: any) => {
      this.handleTestDiscovery(payload);
    });

    // Listen for test results
    this.ipcClient.on("test-result", (payload: any) => {
      this.handleTestResult(payload);
    });

    // Listen for test run complete
    this.ipcClient.on("test-run-complete", (payload: any) => {
      this.handleTestRunComplete(payload);
    });

    // Listen for errors
    this.ipcClient.on("error", (payload: any) => {
      this.handleEngineError(payload);
    });
  }

  async execute() {
    if (this.disposed) {
      vscode.window.showErrorMessage("SmartStart has been disposed");
      return;
    }

    this.outputChannel.show(true);
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No active editor found");
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      editor.document.uri,
    );

    console.log(
      "[Extension] Smart Start initiated for: ",
      editor.document.uri,
      workspaceFolder?.uri.fsPath,
      filePath,
    );

    if (!workspaceFolder) {
      vscode.window.showErrorMessage("File is not part of a workspace");
      return;
    }

    this.workspaceRoot = workspaceFolder.uri.fsPath;

    // Check if it's a test file
    if (!isTestFile(filePath)) {
      vscode.window.showErrorMessage(
        `${path.basename(filePath)} is not a test file (.test.ts, .spec.ts, etc)`,
      );
      return;
    }

    // Initialize session
    if (!this.session) {
      this.session = new SmartStartSession(this.workspaceRoot);
    }

    if (this.ipcClient.isConnected()) {
      // Already connected — just send the request immediately
      this.outputChannel.appendLine(
        `[Extension] Sending smart-start-request for: ${path.basename(filePath)} - ${filePath}`,
      );
      this.ipcClient.send("smart-start-request", { file: filePath });
    } else {
      // Not connected — initialize the engine, then send when connected
      this.pendingSmartStartFile = filePath;
      await this.ensureEngineRunning();
    }

    vscode.window.showInformationMessage(
      `Smart Start initiated for: ${path.basename(filePath)}`,
    );
  }

  private async ensureEngineRunning() {
    if (!this.engineInitializer) {
      this.outputChannel.appendLine(
        "[Extension] Engine initializer not provided",
      );
      vscode.window.showErrorMessage(
        "Failed to initialize Test Engine: Engine not configured",
      );
      return;
    }

    this.outputChannel.appendLine("[Extension] Initializing Core Engine...");
    try {
      const port = await this.engineInitializer();
      this.outputChannel.appendLine(
        `[Extension] Connecting to engine on port ${port}...`,
      );
      await this.connectIPC(port);
    } catch (err: any) {
      this.outputChannel.appendLine(
        `[Extension] Failed to initialize engine: ${err?.message}`,
      );
      vscode.window.showErrorMessage(
        `Failed to initialize Test Engine: ${err?.message}. Check the output panel for details.`,
      );
    }
  }

  private async connectIPC(port: number) {
    try {
      await this.ipcClient.connect(port);
      this.outputChannel.appendLine("[Extension] Connected to engine!");
      vscode.window.setStatusBarMessage("Connected to Test Engine", 3000);

      // Now that we're connected, send the pending smart start request
      if (this.pendingSmartStartFile) {
        this.outputChannel.appendLine(
          `[Extension] Sending deferred smart-start-request for: ${this.pendingSmartStartFile}`,
        );
        this.ipcClient.send("smart-start-request", {
          file: this.pendingSmartStartFile,
        });
        this.pendingSmartStartFile = null;
      }
    } catch (e: any) {
      this.outputChannel.appendLine(
        `[Extension] IPC connection failed: ${e?.message}`,
      );
      vscode.window.showErrorMessage(
        "Failed to connect to Test Engine. Check the output panel for details.",
      );
    }
  }

  /**
   * Handle smart-start-response from the engine
   */
  private handleSmartStartResponse(payload: SmartStartResult) {
    this.outputChannel.appendLine(
      `[Extension] Smart Start resolved: ${payload.project.name} (${payload.testFramework})`,
    );

    if (!this.pendingSmartStartFile && this.session?.isActive()) {
      // Get the file from the current session
      const currentConfig = this.session.getCurrentConfig();
      if (currentConfig.file) {
        this.session.initializeSession(
          currentConfig.file.absolutePath,
          payload,
        );
      }
    } else if (this.pendingSmartStartFile) {
      // Initialize session with the pending file
      this.session?.initializeSession(this.pendingSmartStartFile, payload);
      this.setupFileWatching();
    }

    // Show project and framework info
    vscode.window.showInformationMessage(
      `Running tests in ${payload.project.name} (${payload.testFramework})`,
    );
  }

  /**
   * Handle test discovery results
   */
  private handleTestDiscovery(payload: any) {
    const tests = payload as any[];
    this.outputChannel.appendLine(
      `[Extension] Discovered ${tests.length} test(s)`,
    );

    if (tests.length > 0) {
      this.outputChannel.appendLine(
        `[Extension] Test files: ${tests.map((t) => path.basename(t.file)).join(", ")}`,
      );
    }
  }

  /**
   * Handle individual test results
   */
  private handleTestResult(payload: any) {
    const result = payload as any;
    const statusIcon =
      result.status === "passed" ? "✓" : result.status === "failed" ? "✗" : "○";
    this.outputChannel.appendLine(
      `[Extension] ${statusIcon} ${result.name} (${result.duration}ms)`,
    );

    if (result.status === "failed" && result.error) {
      this.outputChannel.appendLine(
        `[Extension] Error: ${result.error.message}`,
      );
    }
  }

  /**
   * Handle test run completion
   */
  private handleTestRunComplete(payload: any) {
    this.outputChannel.appendLine(`[Extension] Test run complete`);
    vscode.window.setStatusBarMessage("Test run complete", 3000);
  }

  /**
   * Handle engine errors
   */
  private handleEngineError(payload: any) {
    this.outputChannel.appendLine(
      `[Extension] Engine error: ${payload.message}`,
    );
    vscode.window.showErrorMessage(`Test Engine error: ${payload.message}`);
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
    const testFilePattern = new vscode.RelativePattern(
      this.workspaceRoot,
      "**/*.{test,spec}.{ts,js,tsx,jsx,mts,mjs}",
    );

    this.fileWatcher =
      vscode.workspace.createFileSystemWatcher(testFilePattern);

    // On file change, send file change notification to engine
    this.fileWatcher.onDidChange((uri) => {
      const filePath = uri.fsPath;
      this.outputChannel.appendLine(
        `[Extension] Test file changed: ${path.basename(filePath)}`,
      );

      // Check if this file is part of the same session
      if (this.session?.shouldRunInSameSession(filePath)) {
        this.ipcClient.send("file-changed", {
          filePath: filePath,
        });
      }
    });

    this.outputChannel.appendLine(
      `[Extension] File watcher started for test files`,
    );
  }

  dispose() {
    this.disposed = true;
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }
    this.ipcClient.disconnect();
    this.session?.clearSession();
  }
}
