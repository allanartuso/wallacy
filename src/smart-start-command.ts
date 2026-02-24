import * as path from "path";
import Container, { Service } from "typedi";
import { FileSystemWatcher } from "vscode";
import { IPCClient } from "./ipc-client";
import type { SmartStartResult } from "./shared-types";
import { SmartStartSession } from "./smart-start-session";
import { isTestFile } from "./test-utils";
import { VsCodeService } from "./vs-code.service";

@Service()
export class SmartStartCommand {
  private readonly vsCodeService = Container.get(VsCodeService);
  private readonly iPCClient = Container.get(IPCClient);

  private pendingSmartStartFile: string | null = null;
  private session: SmartStartSession | null = null;
  private fileWatcher: FileSystemWatcher | null = null;
  private workspaceRoot: string | null = null;
  private disposed = false;

  constructor() {
    this.setupIPCHandlers();
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

  async execute() {
    this.vsCodeService.showInformationMessage("Hello smartStartCommand!");
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
    const workspaceFolder = this.vsCodeService.getWorkspaceFolder(
      editor.document.uri,
    );

    this.vsCodeService.appendLine(
      "[Extension] Smart Start initiated for: " + editor.document.uri.fsPath,
    );

    if (!workspaceFolder) {
      this.vsCodeService.showErrorMessage("File is not part of a workspace");
      return;
    }

    this.workspaceRoot = workspaceFolder.uri.fsPath;

    if (!isTestFile(filePath)) {
      this.vsCodeService.showErrorMessage(
        `${path.basename(filePath)} is not a test file (.test.ts, .spec.ts, etc)`,
      );
      return;
    }

    if (!this.session) {
      this.session = new SmartStartSession(this.workspaceRoot);
    }

    this.vsCodeService.showInformationMessage(
      `Smart Start initiated for: ${path.basename(filePath)}`,
    );
  }

  /**
   * Handle smart-start-response from the engine
   */
  private handleSmartStartResponse(payload: SmartStartResult) {
    this.vsCodeService.appendLine(
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
    this.vsCodeService.showInformationMessage(
      `Running tests in ${payload.project.name} (${payload.testFramework})`,
    );
  }

  /**
   * Handle test discovery results
   */
  private handleTestDiscovery(payload: any) {
    const tests = payload as any[];
    this.vsCodeService.appendLine(
      `[Extension] Discovered ${tests.length} test(s)`,
    );

    if (tests.length > 0) {
      this.vsCodeService.appendLine(
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
    this.vsCodeService.appendLine(
      `[Extension] ${statusIcon} ${result.name} (${result.duration}ms)`,
    );

    if (result.status === "failed" && result.error) {
      this.vsCodeService.appendLine(
        `[Extension] Error: ${result.error.message}`,
      );
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
    this.vsCodeService.appendLine(
      `[Extension] Engine error: ${payload.message}`,
    );
    this.vsCodeService.showErrorMessage(
      `Test Engine error: ${payload.message}`,
    );
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

    this.fileWatcher =
      this.vsCodeService.createFileSystemWatcher(testFilePattern);

    // On file change, send file change notification to engine
    this.fileWatcher.onDidChange((uri) => {
      const filePath = uri.fsPath;
      this.vsCodeService.appendLine(
        `[Extension] Test file changed: ${path.basename(filePath)}`,
      );

      // Check if this file is part of the same session
      if (this.session?.shouldRunInSameSession(filePath)) {
        this.iPCClient.send("file-changed", {
          filePath: filePath,
        });
      }
    });

    this.vsCodeService.appendLine(
      `[Extension] File watcher started for test files`,
    );
  }

  dispose() {
    this.disposed = true;
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }
    this.iPCClient.disconnect();
    this.session?.clearSession();

    this.vsCodeService.appendLine("[Extension] SmartStartCommand disposed");
  }
}
