/**
 * ConsoleLogInterceptor — Captures console.log/warn/error/info/debug output
 * from user code and maps each call back to its source location.
 *
 * This service works by:
 *   1. Scanning the active document for `console.xxx(...)` calls
 *   2. Instrumenting the code to wrap each console call with a reporter
 *      that captures the output + source location
 *   3. Executing the instrumented code in a Node.js child process
 *   4. Returning ConsoleLogEntry[] with file, line, and serialised output
 *
 * The result is used by EditorDecorations (inline hints) and the webview
 * console pane — giving a Quokka-like "live value" experience.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Service } from 'typedi';
import type { ConsoleLogEntry } from './shared-types';

// ─── Types ──────────────────────────────────────────────────

export interface ConsoleCallSite {
  /** 1-based line number in the original source */
  line: number;
  /** The console method: log, warn, error, info, debug */
  method: string;
  /** Column offset (0-based) of `console.` in the line */
  column: number;
}

export interface InterceptedLog {
  /** The console method used */
  method: string;
  /** Serialised output string */
  output: string;
  /** 1-based line in the original source */
  line: number;
  /** Original file path */
  file: string;
  /** Timestamp of capture */
  timestamp: number;
}

export interface InstrumentResult {
  /** The instrumented source code */
  code: string;
  /** Detected console call sites */
  callSites: ConsoleCallSite[];
}

// ─── Console call detection ─────────────────────────────────

const CONSOLE_RE = /\bconsole\.(log|warn|error|info|debug)\s*\(/g;

/**
 * Scan source code and return all console.xxx( call sites.
 */
export function findConsoleCallSites(source: string): ConsoleCallSite[] {
  const lines = source.split('\n');
  const sites: ConsoleCallSite[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    CONSOLE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CONSOLE_RE.exec(lineText)) !== null) {
      sites.push({
        line: i + 1, // 1-based
        method: match[1],
        column: match.index,
      });
    }
  }

  return sites;
}

// ─── Code instrumentation ───────────────────────────────────

/**
 * Instrument source code so that every `console.xxx(...)` call is wrapped
 * with a reporter that captures the serialised arguments and source location.
 *
 * The instrumented code is self-contained JavaScript that, when executed,
 * writes a JSON array of InterceptedLog entries to a temp file whose path
 * is injected as `__WALLACY_OUTPUT_FILE__`.
 *
 * We replace each `console.<method>(args)` with:
 *   __wallacy_capture__(<line>, '<method>', () => console.<method>(args))
 *
 * This preserves original behaviour (the log still fires) while also
 * recording the serialised output.
 */
export function instrumentSource(
  source: string,
  filePath: string,
): InstrumentResult {
  const callSites = findConsoleCallSites(source);

  if (callSites.length === 0) {
    return { code: source, callSites };
  }

  // Build the capture preamble — injected at the top of the file
  const preamble = `
// ── Wallacy console capture preamble ──
const __wallacy_logs__ = [];
const __wallacy_inspect__ = (typeof require !== 'undefined')
  ? require('util').inspect
  : (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function __wallacy_capture__(line, method, args) {
  const output = args.map(a => {
    try {
      return __wallacy_inspect__(a, { depth: 4, colors: false, maxArrayLength: 100, maxStringLength: 1000 });
    } catch { return String(a); }
  }).join(' ');
  __wallacy_logs__.push({
    method,
    output,
    line,
    file: ${JSON.stringify(filePath)},
    timestamp: Date.now(),
  });
  // Still call the original console method
  console[method](...args);
}

// Override console methods to go through capture
const __wallacy_orig_console__ = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
};

for (const __m__ of ['log', 'warn', 'error', 'info', 'debug']) {
  // Not overriding globally — we use __wallacy_capture__ calls instead
}
// ── End preamble ──

// ── Wrap user code in try/finally so captured logs are always written ──
try {
`;

  // Process each line — replace console.xxx(...) calls with captured versions.
  // We do a line-by-line regex replacement to track line numbers.
  const lines = source.split('\n');
  const instrumentedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    let lineText = lines[i];

    // Replace all console.xxx(...) on this line
    // We use a careful approach: replace `console.method(` with `__wallacy_capture__(line, 'method', [`
    // and the matching `)` with `])`
    // However, matching the closing paren of an arbitrary expression is hard with regex.
    // Instead, we use a simpler approach: wrap using a function call pattern.
    lineText = lineText.replace(
      /\bconsole\.(log|warn|error|info|debug)\s*\(/g,
      (_, method) => `__wallacy_capture__(${lineNum}, '${method}', [`,
    );

    // Now we need to close the array. The simple heuristic: for each replaced
    // opening, we find the matching `)` that closes the original console call
    // and replace it with `])`.
    // For single-line console calls this works well. Multi-line calls need
    // different handling but cover 90%+ of cases.
    if (lineText.includes('__wallacy_capture__')) {
      // Count unclosed capture calls and close them
      // Replace the LAST `)` on the line with `])` for each capture call
      const captureCount = (lineText.match(/__wallacy_capture__/g) || [])
        .length;
      let closingsNeeded = captureCount;
      // Walk backwards and replace `)` with `])`
      const chars = [...lineText];
      for (let j = chars.length - 1; j >= 0 && closingsNeeded > 0; j--) {
        if (chars[j] === ')') {
          // Check this isn't the capture call's own paren
          const before = chars.slice(0, j).join('');
          if (!before.trimEnd().endsWith('__wallacy_capture__')) {
            chars.splice(j, 1, ']', ')');
            closingsNeeded--;
          }
        }
      }
      lineText = chars.join('');
    }

    instrumentedLines.push(lineText);
  }

  // Epilogue: write captured logs to the output file, inside `finally` block
  const epilogue = `
} catch (__wallacy_err__) {
  __wallacy_logs__.push({
    method: 'error',
    output: '[Wallacy] Runtime error: ' + (__wallacy_err__.message || String(__wallacy_err__)),
    line: 0,
    file: ${JSON.stringify(filePath)},
    timestamp: Date.now(),
  });
} finally {
// ── Wallacy capture epilogue ──
const __wallacy_fs__ = require('fs');
__wallacy_fs__.writeFileSync(
  process.env.__WALLACY_OUTPUT_FILE__,
  JSON.stringify(__wallacy_logs__),
  'utf-8'
);
} // end finally
`;

  const code = preamble + '\n' + instrumentedLines.join('\n') + '\n' + epilogue;
  return { code, callSites };
}

// ─── Execution ──────────────────────────────────────────────

/**
 * Execute instrumented code in a child process and collect the captured logs.
 */
export async function executeInstrumented(
  instrumentedCode: string,
  workingDir: string,
  timeoutMs = 10_000,
): Promise<InterceptedLog[]> {
  const { execSync } = await import('child_process');

  // Write instrumented code to a temp file
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const codePath = path.join(tmpDir, `wallacy-eval-${id}.js`);
  const outputPath = path.join(tmpDir, `wallacy-output-${id}.json`);

  try {
    fs.writeFileSync(codePath, instrumentedCode, 'utf-8');
    // Ensure output file exists (empty array) so we can read it even if code fails early
    fs.writeFileSync(outputPath, '[]', 'utf-8');

    execSync(`node "${codePath}"`, {
      cwd: workingDir,
      timeout: timeoutMs,
      env: {
        ...process.env,
        __WALLACY_OUTPUT_FILE__: outputPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 5 * 1024 * 1024, // 5MB
    });

    const raw = fs.readFileSync(outputPath, 'utf-8');
    return JSON.parse(raw) as InterceptedLog[];
  } catch (err: any) {
    // If the script errored, still try to read partial output
    try {
      const raw = fs.readFileSync(outputPath, 'utf-8');
      const logs = JSON.parse(raw) as InterceptedLog[];
      // Add an error entry so the user knows something went wrong
      logs.push({
        method: 'error',
        output: `[Wallacy] Execution error: ${err.message ?? String(err)}`,
        line: 0,
        file: '',
        timestamp: Date.now(),
      });
      return logs;
    } catch {
      return [
        {
          method: 'error',
          output: `[Wallacy] Execution error: ${err.message ?? String(err)}`,
          line: 0,
          file: '',
          timestamp: Date.now(),
        },
      ];
    }
  } finally {
    // Cleanup temp files
    try {
      fs.unlinkSync(codePath);
    } catch {}
    try {
      fs.unlinkSync(outputPath);
    } catch {}
  }
}

// ─── Service ────────────────────────────────────────────────

@Service()
export class ConsoleLogInterceptor {
  /**
   * Evaluate a source file, intercept all console.log calls,
   * and return ConsoleLogEntry[] suitable for EditorDecorations and webview.
   *
   * @param filePath  Absolute path to the source file
   * @param source    File content (avoids re-reading from disk)
   * @param workingDir  Working directory for execution (project root)
   * @param timeoutMs  Max execution time
   */
  async interceptConsoleLogs(
    filePath: string,
    source: string,
    workingDir: string,
    timeoutMs = 10_000,
  ): Promise<ConsoleLogEntry[]> {
    const { code, callSites } = instrumentSource(source, filePath);

    if (callSites.length === 0) {
      return [];
    }

    const intercepted = await executeInstrumented(code, workingDir, timeoutMs);

    return intercepted.map((log) => ({
      stream:
        log.method === 'error' || log.method === 'warn' ? 'stderr' : 'stdout',
      content: log.output,
      file: log.file || filePath,
      line: log.line > 0 ? log.line : undefined,
      timestamp: log.timestamp,
    }));
  }

  /**
   * Quick check: does the source contain any console.xxx() calls?
   */
  hasConsoleCalls(source: string): boolean {
    return findConsoleCallSites(source).length > 0;
  }
}
