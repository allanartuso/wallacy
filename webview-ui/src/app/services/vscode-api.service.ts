/**
 * VsCodeApiService — Typed bridge between Angular and the VS Code Webview API.
 *
 * How VS Code webview communication works:
 * ─────────────────────────────────────────
 * The webview is an iframe sandbox. The extension host injects a global
 * `acquireVsCodeApi()` function that returns a handle for:
 *   - `postMessage(msg)` — send messages TO the extension
 *   - `getState()` / `setState()` — persist state across webview reloads
 *
 * The extension sends messages TO the webview via `panel.webview.postMessage()`.
 * The webview receives them via `window.addEventListener('message', ...)`.
 *
 * This service wraps that into a typed RxJS Observable stream that Angular
 * components can subscribe to.
 */

import {Injectable} from "@angular/core";
import {Observable, Subject} from "rxjs";

// These types mirror the extension's shared-types/webview-messages.ts
// We duplicate them here to avoid complex cross-project imports at build time.

export interface ResolutionPayload {
  projectName: string;
  projectRoot: string;
  testFramework: string;
  configPath: string | null;
  tsconfigPath: string | null;
  dependents: string[];
}

export interface RunCompletePayload {
  results: TestResult[];
  duration: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface TestInfo {
  id: string;
  file: string;
  suite: string[];
  name: string;
  line?: number;
}

export interface TestError {
  message: string;
  stack?: string;
  expected?: unknown;
  actual?: unknown;
  diff?: string;
}

export type TestStatus = "passed" | "failed" | "skipped" | "running";

export interface TestResult {
  testId: string;
  file: string;
  suite: string[];
  name: string;
  status: TestStatus;
  duration: number;
  error?: TestError;
  line?: number;
}

export interface ConsoleLogEntry {
  stream: "stdout" | "stderr";
  content: string;
  file?: string;
  line?: number;
  timestamp: number;
}

export type ExtensionMessage =
  | {type: "clear"}
  | {type: "resolution"; data: ResolutionPayload}
  | {type: "testsDiscovered"; data: TestInfo[]}
  | {type: "testResult"; data: TestResult}
  | {type: "runComplete"; data: RunCompletePayload}
  | {type: "consoleLog"; data: ConsoleLogEntry}
  | {type: "runStarted"; data: {file: string; timestamp: number}};

export type WebviewMessage = {type: "openFile"; file: string; line?: number} | {type: "rerun"} | {type: "ready"};

// VS Code API handle type
interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

// Declare the global function injected by VS Code
declare function acquireVsCodeApi(): VsCodeApi;

@Injectable({providedIn: "root"})
export class VsCodeApiService {
  private readonly api: VsCodeApi | null;
  private readonly messageSubject = new Subject<ExtensionMessage>();

  /** Observable stream of all messages from the extension. */
  readonly messages$: Observable<ExtensionMessage> = this.messageSubject.asObservable();

  constructor() {
    // acquireVsCodeApi is only available inside a VS Code webview.
    // When developing standalone (ng serve), it won't exist.
    try {
      this.api = acquireVsCodeApi();
    } catch {
      this.api = null;
      console.warn("[VsCodeApiService] acquireVsCodeApi not available — running outside VS Code");
    }

    // Listen for messages from the extension.
    // The async pipe in templates calls markForCheck() automatically,
    // so zoneless change detection works without NgZone.run().
    window.addEventListener("message", (event: MessageEvent) => {
      this.messageSubject.next(event.data as ExtensionMessage);
    });

    // Signal to the extension that the webview is ready
    this.postMessage({type: "ready"});
  }

  /** Send a typed message to the extension host. */
  postMessage(message: WebviewMessage): void {
    this.api?.postMessage(message);
  }

  /** Open a file in the editor at an optional line number. */
  openFile(file: string, line?: number): void {
    this.postMessage({type: "openFile", file, line});
  }

  /** Request the extension to re-run the last test file. */
  rerun(): void {
    this.postMessage({type: "rerun"});
  }
}
