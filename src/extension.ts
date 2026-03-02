import 'reflect-metadata';
import Container from 'typedi';
import { ExtensionContext } from 'vscode';
import { ConsoleLogEvalCommand } from './console-log-eval-command';
import { EditorDecorations } from './editor-decorations';
import { SmartStartCommand } from './smart-start-command';
import { VsCodeService } from './vs-code.service';
import { TestResultsPanel } from './webview';

const vsCodeService = Container.get(VsCodeService);
const testResultsPanel = Container.get(TestResultsPanel);
const editorDecorations = Container.get(EditorDecorations);
const consoleLogEvalCommand = Container.get(ConsoleLogEvalCommand);

export async function activate(context: ExtensionContext) {
  const outputChannel = vsCodeService.setupOutputChanel();
  context.subscriptions.push(outputChannel);

  testResultsPanel.setExtensionUri(context.extensionUri);
  editorDecorations.setExtensionUri(context.extensionUri);

  vsCodeService.appendLine(
    'Congratulations, your extension "wallacy" is now active!',
  );

  const smartStartCommand = Container.get(SmartStartCommand);

  const commands = [
    vsCodeService.registerCommand('wallacy.helloWorld', () => {
      vsCodeService.showInformationMessage('Hello World from Wallacy!');
    }),
    vsCodeService.registerCommand('wallacy.smartStart', async () => {
      vsCodeService.appendLine(`[Extension] smartStart started`);
      // Reset disposed state so the command works after a stop/restart cycle
      smartStartCommand.resetDisposed();
      smartStartCommand.execute();
    }),
    vsCodeService.registerCommand('wallacy.stopEngine', async () => {
      smartStartCommand.dispose();
      vsCodeService.appendLine(
        '[Extension] Stopped. Run Smart Start again to restart.',
      );
    }),
    vsCodeService.registerCommand('wallacy.resetCache', () => {
      smartStartCommand.resetCache();
    }),
    vsCodeService.registerCommand('wallacy.forceRerun', async () => {
      smartStartCommand.resetDisposed();
      smartStartCommand.forceRerun();
    }),
    vsCodeService.registerCommand('wallacy.evalConsoleLogs', async () => {
      vsCodeService.appendLine('[Extension] Evaluate Console Logs triggered');
      consoleLogEvalCommand.evaluate();
    }),
    vsCodeService.registerCommand('wallacy.toggleLiveConsole', () => {
      vsCodeService.appendLine('[Extension] Toggle Live Console triggered');
      consoleLogEvalCommand.toggleLiveMode();
    }),
  ];

  context.subscriptions.push(...commands);
}

export function deactivate() {}
