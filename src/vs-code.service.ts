import { Service } from "typedi";
import {
  commands,
  GlobPattern,
  OutputChannel,
  RelativePattern,
  Uri,
  window,
  workspace,
  WorkspaceFolder,
} from "vscode";

@Service()
export class VsCodeService {
  private outputChannel: OutputChannel | undefined;

  get activeTextEditor() {
    return window.activeTextEditor;
  }

  setupOutputChanel() {
    this.outputChannel = window.createOutputChannel("Wallacy");
    this.outputChannel.appendLine("Output channel set!");
    return this.outputChannel;
  }

  appendLine(value: string) {
    this.outputChannel?.appendLine(value);
  }

  show(preserveFocus?: boolean | undefined) {
    this.outputChannel?.show(preserveFocus);
  }

  createFileSystemWatcher(
    globPattern: GlobPattern,
    ignoreCreateEvents?: boolean,
    ignoreChangeEvents?: boolean,
    ignoreDeleteEvents?: boolean,
  ) {
    return workspace.createFileSystemWatcher(
      globPattern,
      ignoreCreateEvents,
      ignoreChangeEvents,
      ignoreDeleteEvents,
    );
  }

  showErrorMessage(message: string, ...items: string[]) {
    window.showErrorMessage(message, ...items);
  }

  setStatusBarMessage(text: string, hideAfterTimeout: number) {
    window.setStatusBarMessage(text, hideAfterTimeout);
  }

  getWorkspaceFolder(uri: Uri) {
    return workspace.getWorkspaceFolder(uri);
  }

  showInformationMessage(message: string, ...items: string[]) {
    window.showInformationMessage(message, ...items);
  }

  createRelativePattern(base: string | Uri | WorkspaceFolder, pattern: string) {
    return new RelativePattern(base, pattern);
  }

  getWorkspaceRoot() {
    return workspace.workspaceFolders?.[0].uri.fsPath;
  }

  registerCommand(
    command: string,
    callback: (...args: any[]) => any,
    thisArg?: any,
  ) {
    return commands.registerCommand(command, callback, thisArg);
  }
}
