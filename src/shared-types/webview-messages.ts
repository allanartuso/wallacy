/**
 * Shared message types for Extension ↔ Webview communication.
 *
 * These types define the `postMessage` protocol used between the
 * VS Code extension host and the Angular webview. Both sides import
 * from this single source of truth.
 *
 * Communication mechanism: VS Code Webview `postMessage` API.
 * This is the official, supported way for extensions to communicate
 * with webview panels — NOT websockets or HTTP.
 */

import type {ConsoleLogEntry, TestInfo, TestResult} from "./shared-types";

// ─── Extension → Webview ────────────────────────────────────

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

export type ExtensionToWebviewMessage =
  | {type: "clear"}
  | {type: "resolution"; data: ResolutionPayload}
  | {type: "testsDiscovered"; data: TestInfo[]}
  | {type: "testResult"; data: TestResult}
  | {type: "runComplete"; data: RunCompletePayload}
  | {type: "consoleLog"; data: ConsoleLogEntry}
  | {type: "runStarted"; data: {file: string; timestamp: number}}
  | {type: "cachedResult"; data: {file: string; cachedAt: number; contentHash: string}};

// ─── Webview → Extension ────────────────────────────────────

export type WebviewToExtensionMessage =
  | {type: "openFile"; file: string; line?: number}
  | {type: "rerun"}
  | {type: "ready"};
