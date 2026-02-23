// ============================================================
// StaticAnalysisSeed — Scans source files for imports to
// create an initial dependency graph.
//
// WHY: We need a baseline graph before any tests have run.
// This allows us to identify affected tests even on the first
// run or for files that don't yet have runtime coverage.
// ============================================================

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as path from "node:path";
import type { DependencyGraph } from "./graph";

const _traverse = (traverse as any).default || traverse;

export class StaticAnalysisSeed {
  constructor(private readonly graph: DependencyGraph) {}

  /**
   * Scan a file for imports and add them to the graph.
   * @param filePath Absolute path of the file to scan
   * @param code Content of the file
   */
  async scanFile(filePath: string, code: string): Promise<void> {
    try {
      const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx", "decorators-legacy", "classProperties"],
      });

      const directory = path.dirname(filePath);
      const self = this;

      _traverse(ast, {
        ImportDeclaration(p: any) {
          const source = p.node.source.value;
          self.addEdge(filePath, source, directory);
        },
        ExportNamedDeclaration(p: any) {
          if (p.node.source) {
            self.addEdge(filePath, p.node.source.value, directory);
          }
        },
        ExportAllDeclaration(p: any) {
          self.addEdge(filePath, p.node.source.value, directory);
        },
        CallExpression(p: any) {
          // Handle require('...') or import('...')
          if (
            (p.node.callee.name === "require" ||
              p.node.callee.type === "Import") &&
            p.node.arguments.length > 0 &&
            p.node.arguments[0].type === "StringLiteral"
          ) {
            self.addEdge(filePath, p.node.arguments[0].value, directory);
          }
        },
      });
    } catch (e) {
      console.error(e);
      // Parsing error (e.g. invalid syntax) — skip this file's static analysis
    }
  }

  private addEdge(
    dependent: string,
    importPath: string,
    directory: string,
  ): void {
    if (importPath.startsWith(".")) {
      // Use path.join to avoid drive-letter prepending if directory is a virtual root
      const resolved = path.join(directory, importPath);
      // Key for the imported file (candidate): remove extension to be fuzzy
      const fromKey = this.stripExtension(this.normalizePath(resolved));
      // Key for the dependent file (source): keep extension for precision
      const toKey = this.normalizePath(dependent);

      this.graph.addDependency(fromKey, toKey, "static");
    }
  }

  private normalizePath(p: string): string {
    // 1. Normalize slashes to forward
    let normalized = p.replace(/\\/g, "/");
    // 2. Remove leading drive letter (e.g. D:)
    normalized = normalized.replace(/^[a-zA-Z]:/, "");
    // 3. Ensure it starts with /
    if (!normalized.startsWith("/")) {
      normalized = "/" + normalized;
    }
    return normalized;
  }

  private stripExtension(p: string): string {
    return p.replace(/\.(ts|js|tsx|jsx|mjs|cjs)$/, "");
  }
}
