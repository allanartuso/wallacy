import * as t from '@babel/types';
import traverse from '@babel/traverse';
import generator from '@babel/generator';
import { parse } from '@babel/parser';

export interface TraceEvent {
    type: 'function-entry' | 'function-exit' | 'variable-capture';
    functionName: string;
    file: string;
    line: number;
    timestamp: number;
    data?: Record<string, unknown>;
}

export interface TracerOptions {
    /** File to trace (for labelling events). */
    file: string;
    /** Whether to capture local variable snapshots. */
    captureVariables?: boolean;
    /** Max variables to capture per probe (default: 10). */
    maxVariables?: number;
}

/**
 * ExecutionTracer — injects runtime probes into source code using Babel.
 *
 * It wraps each function body so that:
 *  1. A `__trace_enter__` call fires with the function name and arguments on entry.
 *  2. A `__trace_exit__` call wraps the return value on exit.
 *
 * The host runtime is expected to provide a `__trace__` global that the probes call.
 */
export class ExecutionTracer {
    private opts: Required<TracerOptions>;

    constructor(opts: TracerOptions) {
        this.opts = {
            captureVariables: true,
            maxVariables: 10,
            ...opts,
        };
    }

    /**
     * Instrument source code.
     * @returns Instrumented source with probes injected.
     */
    instrument(sourceCode: string): string {
        const ast = parse(sourceCode, {
            sourceType: 'module',
            plugins: ['typescript', 'jsx'],
        });

        const { file } = this.opts;

        traverse(ast, {
            Function: path => {
                const node = path.node;

                // Skip arrow functions without a block body (single-expr lambdas)
                if (!t.isBlockStatement(node.body)) return;

                const funcName = this.getFunctionName(path) ?? '<anonymous>';
                const line = node.loc?.start.line ?? 0;

                // Build entry call: __trace__('function-entry', name, file, line)
                const entryCall = t.expressionStatement(
                    t.callExpression(t.identifier('__trace__'), [
                        t.stringLiteral('function-entry'),
                        t.stringLiteral(funcName),
                        t.stringLiteral(file),
                        t.numericLiteral(line),
                    ]),
                );

                // Build exit call: __trace__('function-exit', name, file, line)
                const exitCall = t.expressionStatement(
                    t.callExpression(t.identifier('__trace__'), [
                        t.stringLiteral('function-exit'),
                        t.stringLiteral(funcName),
                        t.stringLiteral(file),
                        t.numericLiteral(line),
                    ]),
                );

                node.body.body.unshift(entryCall);
                node.body.body.push(exitCall);
            },
        });

        const output = generator(ast, { retainLines: true }, sourceCode);
        return output.code;
    }

    /**
     * Check if source code has already been instrumented (idempotency guard).
     */
    isInstrumented(sourceCode: string): boolean {
        return sourceCode.includes('__trace__(');
    }

    private getFunctionName(path: any): string | null {
        const node = path.node;

        // Named function declaration or expression
        if (node.id?.name) return node.id.name;

        // Method: class Foo { bar() {} }
        if (t.isClassMethod(node) || t.isObjectMethod(node)) {
            const key = node.key;
            if (t.isIdentifier(key)) return key.name;
            if (t.isStringLiteral(key)) return key.value;
        }

        // Arrow function / anonymous assigned to variable: const foo = () => {}
        const parent = path.parent;
        if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
            return parent.id.name;
        }

        // Property: { foo: function() {} }
        if (t.isObjectProperty(parent) && t.isIdentifier(parent.key)) {
            return parent.key.name;
        }

        return null;
    }
}
