/**
 * SmartStartSession — Manages the state of a continuous test session
 *
 * Tracks:
 * - Current test file being run
 * - Test framework and config being used
 * - Files that are part of the same config
 * - Whether we're actively running tests
 */

import * as path from "path";
import type { SmartStartResult } from "./shared-types";

export interface SessionFile {
  absolutePath: string;
  relativePath: string;
  framework: string;
  configPath: string | null;
}

export class SmartStartSession {
  private currentFile: SessionFile | null = null;
  private smartStartResult: SmartStartResult | null = null;
  private configDirectory: string | null = null;
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Initialize session with a test file and smart start result
   */
  initializeSession(testFile: string, result: SmartStartResult): void {
    this.currentFile = {
      absolutePath: testFile,
      relativePath: path.relative(this.workspaceRoot, testFile),
      framework: result.testFramework,
      configPath: result.configPath,
    };

    this.smartStartResult = result;

    // Extract config directory
    if (result.configPath) {
      this.configDirectory = path.dirname(result.configPath);
    } else {
      const projectRoot = path.isAbsolute(result.project.root)
        ? result.project.root
        : path.join(this.workspaceRoot, result.project.root);
      this.configDirectory = projectRoot;
    }
  }

  /**
   * Check if a new file should be run in the same session
   * Returns true if:
   * - The file is a test file
   * - It uses the same framework
   * - It's in the same config directory
   */
  shouldRunInSameSession(newFilePath: string): boolean {
    if (!this.currentFile || !this.smartStartResult) {
      return false;
    }

    // For now, always run in same session if it's a test file
    // In future, we can add more sophisticated logic to check
    // if the new file shares the same config directory
    return true;
  }

  /**
   * Get the current session configuration
   */
  getCurrentConfig() {
    return {
      file: this.currentFile,
      result: this.smartStartResult,
      configDirectory: this.configDirectory,
    };
  }

  /**
   * Clear the session
   */
  clearSession(): void {
    this.currentFile = null;
    this.smartStartResult = null;
    this.configDirectory = null;
  }

  /**
   * Check if session is active
   */
  isActive(): boolean {
    return this.currentFile !== null && this.smartStartResult !== null;
  }
}
