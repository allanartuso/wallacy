// ============================================================
// InstrumentationTransformer — Babel-based code instrumentation
// for coverage, value capture, and execution tracing.
//
// HOW: It parses the code into an AST, traverses it to inject
// global probe calls (__cov, __trace), and generates the
// instrumented code along with a source map.
// ============================================================

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";
import { InstrumentationOptions, InstrumentedFile } from "../../shared-types";

const _traverse = (traverse as any).default || traverse;
const _generate = (generate as any).default || generate;

export class InstrumentationTransformer {
  /**
   * Instrument a file for coverage and tracing.
   *
   * @param filePath Absolute path to the original file
   * @param code Original source code
   * @param options Instrumentation options
   * @param originalHash Precomputed hash of the original content
   */
  async instrument(
    filePath: string,
    code: string,
    options: InstrumentationOptions,
    originalHash: string,
  ): Promise<InstrumentedFile> {
    const ast = parse(code, {
      sourceType: "module",
      plugins: [
        "typescript",
        "jsx",
        "decorators-legacy",
        "classProperties",
        "exportDefaultFrom",
        "exportNamespaceFrom",
        "dynamicImport",
        "objectRestSpread",
        "optionalChaining",
        "nullishCoalescingOperator",
      ],
      sourceFilename: filePath,
    });

    const fileId = this.getFileId(filePath);

    // ──────────────────────────────────────────────────────────
    // Traversal — Injecting Probes
    // ──────────────────────────────────────────────────────────

    const self = this;
    const visitor = {
      // 1. Function entry/exit tracing
      Function(path: any) {
        if (options.functionTracing) {
          const fnName = self.getFunctionName(path);
          const loc = path.node.loc;

          // Inject entry probe at the start of the body
          const body = path.get("body");
          if (body.isBlockStatement()) {
            body.unshiftContainer(
              "body",
              self.createTraceCall("function-enter", fileId, fnName, loc),
            );
          }
        }
      },

      // 2. Return statements (function exit)
      ReturnStatement(path: any) {
        if (options.functionTracing) {
          const fnPath = path.getFunctionParent();
          if (fnPath) {
            const fnName = self.getFunctionName(fnPath);
            const loc = path.node.loc;
            path.insertBefore(
              self.createTraceCall("function-exit", fileId, fnName, loc),
            );
          }
        }
      },

      // 3. Line coverage
      Statement(path: any) {
        // Skip non-executable statements and declarations
        if (
          options.lineCoverage &&
          !path.isBlockStatement() &&
          !path.isFunctionDeclaration() &&
          !path.isTSInterfaceDeclaration() &&
          !path.isTSTypeAliasDeclaration() &&
          !path.isTSEnumDeclaration() &&
          !path.isTSModuleDeclaration() &&
          !path.isVariableDeclaration() // Variable declarations are often handled via their declarators or just the line
        ) {
          const loc = path.node.loc;
          if (loc) {
            path.insertBefore(
              self.createCoverageIncrement(fileId, loc.start.line),
            );
          }
        }

        // Special handling for variable declarations: we want to instrument them,
        // but we should check if they are just types or actual code.
        if (options.lineCoverage && path.isVariableDeclaration()) {
          const loc = path.node.loc;
          if (loc) {
            path.insertBefore(
              self.createCoverageIncrement(fileId, loc.start.line),
            );
          }
        }
      },

      // 4. Assignments (value capture)
      AssignmentExpression(path: any) {
        if (options.valueCapture) {
          const loc = path.node.loc;
          const left = path.node.left;
          if (t.isIdentifier(left) && loc) {
            // Transform: x = val  -->  x = __trace.capture('x', val, loc)
            const right = path.node.right;
            path.node.right = t.callExpression(
              t.memberExpression(
                t.identifier("__trace"),
                t.identifier("capture"),
              ),
              [
                t.stringLiteral(left.name),
                right,
                t.valueToNode({
                  fileId,
                  line: loc.start.line,
                  col: loc.start.column,
                }),
              ],
            );
          }
        }
      },
    };

    _traverse(ast, visitor);

    // ──────────────────────────────────────────────────────────
    // Code Generation
    // ──────────────────────────────────────────────────────────

    const output = _generate(
      ast,
      {
        sourceMaps: true,
        sourceFileName: filePath,
      },
      code,
    );

    return {
      originalPath: filePath,
      code: output.code,
      sourceMap: JSON.stringify(output.map),
      originalHash,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────

  private getFileId(filePath: string): string {
    // In a real system, this might be a numeric ID or a short hash
    return filePath.replace(/\\/g, "/");
  }

  private getFunctionName(path: any): string {
    if (path.node.id) {
      return path.node.id.name;
    }
    if (
      path.parentPath.isVariableDeclarator() &&
      t.isIdentifier(path.parentPath.node.id)
    ) {
      return path.parentPath.node.id.name;
    }
    return "(anonymous)";
  }

  private createTraceCall(
    type: string,
    fileId: string,
    name: string,
    loc: any,
  ) {
    return t.expressionStatement(
      t.callExpression(
        t.memberExpression(t.identifier("__trace"), t.identifier("log")),
        [
          t.stringLiteral(type),
          t.stringLiteral(fileId),
          t.stringLiteral(name),
          t.valueToNode({ line: loc?.start.line, col: loc?.start.column }),
        ],
      ),
    );
  }

  private createCoverageIncrement(fileId: string, line: number) {
    // __cov['fileId'][line]++
    return t.expressionStatement(
      t.updateExpression(
        "++",
        t.memberExpression(
          t.memberExpression(
            t.identifier("__cov"),
            t.stringLiteral(fileId),
            true,
          ),
          t.numericLiteral(line),
          true,
        ),
      ),
    );
  }
}
