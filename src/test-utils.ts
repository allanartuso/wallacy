/**
 * Test utilities for identifying test files and managing test sessions.
 */

/**
 * Patterns for identifying test files across frameworks
 */
export const TEST_FILE_PATTERNS = {
  vitest: [
    /\.test\.(ts|js|tsx|jsx|mts|mjs)$/,
    /\.spec\.(ts|js|tsx|jsx|mts|mjs)$/,
  ],
  jest: [/\.test\.(ts|js|tsx|jsx)$/, /\.spec\.(ts|js|tsx|jsx)$/],
  jasmine: [/\.spec\.(ts|js)$/],
  generic: [/\.(test|spec)\.(ts|js|tsx|jsx|mts|mjs)$/],
};

/**
 * Check if a file path is a test file
 */
export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.generic.some((pattern) => pattern.test(filePath));
}

/**
 * Get test framework config file names for searching
 */
export function getConfigFilePatterns(
  framework?: string,
): Array<{ name: string; framework: string }> {
  const patterns = [
    // Vitest
    { name: "vitest.config.ts", framework: "vitest" },
    { name: "vitest.config.js", framework: "vitest" },
    { name: "vitest.config.mjs", framework: "vitest" },
    { name: "vite.config.ts", framework: "vitest" },
    { name: "vite.config.js", framework: "vitest" },
    // Jest
    { name: "jest.config.ts", framework: "jest" },
    { name: "jest.config.js", framework: "jest" },
    { name: "jest.config.mjs", framework: "jest" },
    { name: "jest.config.cjs", framework: "jest" },
    { name: "jest.config.json", framework: "jest" },
    // Jasmine
    { name: "jasmine.json", framework: "jasmine" },
    { name: ".jasmine.json", framework: "jasmine" },
  ];

  if (framework) {
    return patterns.filter((p) => p.framework === framework);
  }
  return patterns;
}

/**
 * Get the framework name from a config file name
 */
export function getFrameworkFromConfigFile(
  configFileName: string,
): string | null {
  for (const { name, framework } of getConfigFilePatterns()) {
    if (name === configFileName) {
      return framework;
    }
  }
  return null;
}

/**
 * Get tsconfig file names for searching
 */
export function getTsconfigFileNames(): string[] {
  return ["tsconfig.json", "tsconfig.app.json"];
}
