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

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "wallacy" is now active!');

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;

  if (!workspaceRoot) {
    throw new Error("no workspaceRoot");
  }

  const outputChannel = vscode.window.createOutputChannel(
    "Continuous Test Runner",
  );

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
      outputChannel.appendLine(
        `[Extension] Core Engine started on port ${port}`,
      );
      return port;
    } catch (error: any) {
      throw new Error(`Failed to load core-engine: ${error?.message}`);
    }
  };

  ipcClient = new IPCClient(outputChannel);
  smartStartCommand = new SmartStartCommand(
    context,
    ipcClient,
    outputChannel,
    engineInitializer,
  );

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  const commands = [
    vscode.commands.registerCommand("wallacy.helloWorld", () => {
      // The code you place here will be executed every time your command is executed
      // Display a message box to the user
      vscode.window.showInformationMessage("Hello World from Wallacy!");
    }),
    vscode.commands.registerCommand("wallacy.smartStart", () => {
      vscode.window.showInformationMessage("Hello smartStartCommand!");
      smartStartCommand?.execute();
    }),
    vscode.commands.registerCommand("wallacy.stopEngine", async () => {
      smartStartCommand?.dispose();
      if (engineCleanup) {
        await engineCleanup();
        engineCleanup = null;
        enginePort = null;
      }
    }),
  ];

  context.subscriptions.push(...commands);
}

// This method is called when your extension is deactivated
export function deactivate() {}
