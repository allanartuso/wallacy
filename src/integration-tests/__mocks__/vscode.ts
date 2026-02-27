/**
 * Minimal vscode mock for integration tests.
 *
 * The VsCodeService (and anything that transitively imports from "vscode")
 * needs this stub when running outside the VS Code extension host.
 */

export const window = {
  activeTextEditor: undefined,
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
  showInformationMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
};

export const workspace = {
  workspaceFolders: [],
  getWorkspaceFolder: () => undefined,
  getConfiguration: () => ({
    get: () => undefined,
    has: () => false,
    inspect: () => undefined,
    update: () => Promise.resolve(),
  }),
  createFileSystemWatcher: () => ({
    onDidChange: () => ({dispose: () => {}}),
    onDidCreate: () => ({dispose: () => {}}),
    onDidDelete: () => ({dispose: () => {}}),
    dispose: () => {},
  }),
  findFiles: () => Promise.resolve([]),
  fs: {
    readFile: () => Promise.resolve(new Uint8Array()),
    writeFile: () => Promise.resolve(),
    stat: () => Promise.resolve({type: 1, ctime: 0, mtime: 0, size: 0}),
  },
};

export const commands = {
  registerCommand: () => ({dispose: () => {}}),
  executeCommand: () => Promise.resolve(undefined),
};

export const Uri = {
  file: (path: string) => ({scheme: "file", path, fsPath: path}),
  parse: (uri: string) => ({scheme: "file", path: uri, fsPath: uri}),
};

export class RelativePattern {
  constructor(
    public base: any,
    public pattern: string,
  ) {}
}

export const EventEmitter = class {
  event = () => {};
  fire() {}
  dispose() {}
};

// Type stubs
export type GlobPattern = string | {base: string; pattern: string};
export type OutputChannel = ReturnType<typeof window.createOutputChannel>;
export type WorkspaceFolder = {uri: {fsPath: string}; name: string; index: number};
