import * as path from 'path';
import * as vscode from 'vscode';
import { IPCClient } from './ipc-client';

export class SmartStartCommand {
    private ipcClient: IPCClient;
    private outputChannel: vscode.OutputChannel;
    private pendingSmartStartFile: string | null = null;
    private engineInitializer: (() => Promise<number>) | null = null;

    constructor(
        context: vscode.ExtensionContext,
        client: IPCClient,
        outputChannel: vscode.OutputChannel,
        engineInitializer?: () => Promise<number>,
    ) {
        this.outputChannel = outputChannel;
        this.ipcClient = client;
        this.engineInitializer = engineInitializer || null;
    }

    async execute() {
        this.outputChannel.show(true);
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        console.log(
            '[Extension] Smart Start initiated for: ',
            editor.document.uri,
            workspaceFolder?.uri.fsPath,
            filePath,
        );

        if (!workspaceFolder) {
            vscode.window.showErrorMessage('File is not part of a workspace');
            return;
        }

        if (this.ipcClient.isConnected()) {
            // Already connected — just send the request immediately
            this.outputChannel.appendLine(
                `[Extension] Sending smart-start-request for: ${path.basename(filePath)} - ${filePath}`,
            );
            this.ipcClient.send('smart-start-request', { file: filePath });
        } else {
            // Not connected — initialize the engine, then send when connected
            this.pendingSmartStartFile = filePath;
            await this.ensureEngineRunning();
        }

        vscode.window.showInformationMessage(`Smart Start initiated for: ${path.basename(filePath)}`);
    }

    private async ensureEngineRunning() {
        if (!this.engineInitializer) {
            this.outputChannel.appendLine('[Extension] Engine initializer not provided');
            vscode.window.showErrorMessage('Failed to initialize Test Engine: Engine not configured');
            return;
        }

        this.outputChannel.appendLine('[Extension] Initializing Core Engine...');
        try {
            const port = await this.engineInitializer();
            this.outputChannel.appendLine(`[Extension] Connecting to engine on port ${port}...`);
            await this.connectIPC(port);
        } catch (err: any) {
            this.outputChannel.appendLine(`[Extension] Failed to initialize engine: ${err?.message}`);
            vscode.window.showErrorMessage(
                `Failed to initialize Test Engine: ${err?.message}. Check the output panel for details.`,
            );
        }
    }

    private async connectIPC(port: number) {
        try {
            await this.ipcClient.connect(port);
            this.outputChannel.appendLine('[Extension] Connected to engine!');
            vscode.window.setStatusBarMessage('Connected to Test Engine', 3000);

            // Now that we're connected, send the pending smart start request
            if (this.pendingSmartStartFile) {
                this.outputChannel.appendLine(
                    `[Extension] Sending deferred smart-start-request for: ${this.pendingSmartStartFile}`,
                );
                this.ipcClient.send('smart-start-request', { file: this.pendingSmartStartFile });
                this.pendingSmartStartFile = null;
            }
        } catch (e: any) {
            this.outputChannel.appendLine(`[Extension] IPC connection failed: ${e?.message}`);
            vscode.window.showErrorMessage('Failed to connect to Test Engine. Check the output panel for details.');
        }
    }

    dispose() {
        this.ipcClient.disconnect();
    }
}
