// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { IPCClient } from "./ipc-client";
import { SmartStartCommand } from "./smart-start-command";
import { startCoreEngine } from "./core-engine";

let ipcClient: IPCClient | null = null;
let smartStartCommand: SmartStartCommand | null = null;
let enginePort: number | null = null;
let engineCleanup: (() => Promise<void>) | null = null;

console.log('Congratulations, your extension "wallacy" is now active!');

const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;

if (!workspaceRoot) {
  throw new Error("no workspaceRoot");
}

const outputChannel = {
  appendLine: (text: string) => text,
  show: (flag: boolean) => {},
} as unknown as vscode.OutputChannel;

const engineInitializer = async (): Promise<number> => {
  if (enginePort !== null) {
    // Engine already initialized
    return enginePort;
  }

  outputChannel.appendLine("[Extension] Starting Core Engine...");
  try {
    // Dynamically require core-engine to avoid bundling it with the extension

    const { port, cleanup } = await startCoreEngine(workspaceRoot);
    enginePort = port;
    engineCleanup = cleanup;
    outputChannel.appendLine(`[Extension] Core Engine started on port ${port}`);
    return port;
  } catch (error: any) {
    throw new Error(`Failed to load core-engine: ${error?.message}`);
  }
};

ipcClient = new IPCClient(outputChannel);
smartStartCommand = new SmartStartCommand(
  undefined,
  ipcClient,
  outputChannel,
  engineInitializer,
);

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate() {
  smartStartCommand?.execute();
}

// This method is called when your extension is deactivated
export function deactivate() {}
