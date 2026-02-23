import type { NxProjectInfo, TestFrameworkName } from "../shared-types";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export class AdapterAutoDetector {
  /**
   * Detect the test framework for an Nx project.
   *
   * Strategy:
   * 1. Check executor name in project targets (e.g. @nx/jest:jest)
   * 2. Check for config files (jest.config.ts, vitest.config.ts)
   * 3. Default to vitest (our preferred framework)
   */
  static async detectFramework(
    project: NxProjectInfo,
    workspaceRoot: string,
  ): Promise<TestFrameworkName> {
    // 1. Check executor
    for (const target of Object.values(project.targets)) {
      if (target.executor?.includes("jest")) return "jest";
      if (target.executor?.includes("vitest")) return "vitest";
      if (target.executor?.includes("jasmine")) return "jasmine";
    }

    // 2. Check for config files in project root
    const projectRootAbs = path.join(workspaceRoot, project.root);
    try {
      const files = await fs.readdir(projectRootAbs);
      if (files.some((f) => f.startsWith("vitest.config"))) return "vitest";
      if (files.some((f) => f.startsWith("jest.config"))) return "jest";
      if (files.some((f) => f.includes("jasmine.json"))) return "jasmine";
    } catch {
      // Ignore readdir errors
    }

    // 3. Last resort: Default to vitest
    return "vitest";
  }
}
