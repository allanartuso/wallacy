import * as path from "node:path";
import {
  DependencyGraph,
  GraphDiffEngine,
  StaticAnalysisSeed,
} from "./dependency-graph";
import { IPCServer } from "./ipc/server";
import { FileToProjectMapper, NxWorkspaceResolver } from "./nx-resolver";
import { ExecutionQueue, TestExecutor, TestScheduler } from "./scheduler";
import { SmartStartResolver } from "./smart-start/smart-start-resolver";
import {
  BufferSync,
  FileChangeEvent,
  FileWatcher,
  VirtualFileSystem,
} from "./vfs";
import { JasmineAdapter, JestAdapter, VitestAdapter } from "../test-adapters";

/**
 * Exported function to initialize and start the core engine.
 * Can be called directly from the extension instead of spawning a subprocess.
 */
export async function startCoreEngine(
  workspaceRoot: string,
): Promise<{ port: number; server: IPCServer; cleanup: () => Promise<void> }> {
  // 1. Core Engine Subsystems
  const vfs = new VirtualFileSystem();
  const workspaceResolver = new NxWorkspaceResolver(workspaceRoot);
  const projectMapper = new FileToProjectMapper(workspaceResolver);
  const depGraph = new DependencyGraph();
  const staticAnalysis = new StaticAnalysisSeed(depGraph);
  const diffEngine = new GraphDiffEngine(depGraph, staticAnalysis, vfs);

  const server = new IPCServer();
  const executor = new TestExecutor(server, projectMapper, workspaceRoot);
  const executionQueue = new ExecutionQueue(executor);
  const scheduler = new TestScheduler(
    vfs,
    depGraph,
    projectMapper,
    executionQueue,
  );

  const smartResolver = new SmartStartResolver(
    workspaceResolver,
    projectMapper,
  );
  const watcher = new FileWatcher(workspaceRoot, vfs);
  const bufferSync = new BufferSync(vfs);

  // 2. Wire up listeners
  watcher.on("changes", async (changes: FileChangeEvent[]) => {
    console.log(`[Core Engine] ${changes.length} files changed on disk`);
    const filePaths = changes.map((c: FileChangeEvent) => c.filePath);

    // Update graph
    await diffEngine.handleBatchChanges(filePaths);

    // Trigger scheduler
    await scheduler.onFilesChanged(filePaths);
  });

  bufferSync.on("buffer-update", async (event) => {
    // When a buffer is updated, we treat it as a file change for the scheduler
    await diffEngine.handleFileChange(event.filePath);
    await scheduler.onFilesChanged([event.filePath]);
  });

  // 3. IPC Server Start
  const port = server.start(0);
  console.log(`[Core Engine] IPC Server started on port ${port}`);
  console.log(`[Core Engine] Workspace root: ${workspaceRoot}`);

  // Keep process alive
  process.stdin.resume();

  // Handle termination
  process.on("SIGINT", async () => {
    await watcher.stop();
    server.stop();
    process.exit(0);
  });

  // 4. Protocol Handlers
  server.onMessage("smart-start-request", async (payload: any) => {
    const { file } = payload;
    console.log(`[Core Engine] Handling smart-start-request for: ${file}`);

    try {
      server.broadcast("engine-status", "starting");

      // Resolve project and framework
      const result = await smartResolver.resolve(file);
      const absoluteProjectRoot = path.isAbsolute(result.project.root)
        ? result.project.root
        : path.join(workspaceRoot, result.project.root);

      console.log(
        `[Core Engine] Resolved: ${result.project.name} (${result.testFramework}), root: ${absoluteProjectRoot}`,
      );

      // Notify UI
      server.broadcast("smart-start-response", result);

      // Lightweight discovery: just glob files — no Vitest instance created
      const discoveryAdapter =
        result.testFramework === "vitest"
          ? new VitestAdapter()
          : result.testFramework === "jest"
            ? new JestAdapter()
            : new JasmineAdapter();

      console.log(`[Core Engine] Discovering tests in: ${absoluteProjectRoot}`);
      const tests = await discoveryAdapter.discoverTests(
        absoluteProjectRoot,
        result.configPath,
      );
      console.log(`[Core Engine] Discovered ${tests.length} test file(s)`);
      server.broadcast("test-discovery", tests);

      // Start file watcher in background (don't block test execution)
      if (!watcher.isWatching()) {
        watcher
          .start()
          .catch((e: Error) =>
            console.error("[Core Engine] Watcher error:", e.message),
          );
      }

      // Only directly enqueue if it looks like a test file.
      // If it's a source file, the scheduler will pick it up once the watcher
      // and dependency graph have processed it.
      const isTestFile = /\.(test|spec)\.(ts|js|tsx|jsx|mts|mjs)$/.test(file);
      if (isTestFile) {
        console.log(
          `[Core Engine] Enqueueing run for test file: ${path.basename(file)}`,
        );
        executionQueue.enqueue({
          testFiles: new Set([file]),
          projectNames: new Set([result.project.name]),
          priority: 1000,
          timestamp: Date.now(),
        });
      } else {
        console.log(
          `[Core Engine] Focused file is not a test file. Waiting for dependency analysis...`,
        );
        // We can still trigger a manual check for this file in the scheduler
        // once we're sure the VFS has it.
        // TODO: readFile doesn't exist
        (vfs as any).readFile(file).then(() => {
          console.log(
            `[Core Engine] Triggering scheduler for file: ${path.basename(file)}`,
          );
          scheduler.onFilesChanged([file]);
        });
      }
    } catch (error: any) {
      console.error(`[Core Engine] Smart Start failed: ${error.message}`);
      if (error.stack) {
        console.error(error.stack);
      }
      server.broadcast("error", {
        message: `Smart Start failed: ${error.message}`,
      });
      server.broadcast("engine-status", "error");
    }
  });

  server.onMessage("buffer-update", (payload: any) => {
    const { filePath, content } = payload;
    bufferSync.applyBufferUpdate(filePath, content);
  });

  server.onMessage("run-all-tests", async () => {
    console.log("[Core Engine] Run all tests requested");
    const allProjects = await workspaceResolver.getAllProjects();

    executionQueue.enqueue({
      testFiles: new Set(), // Executor will discover all tests if empty
      projectNames: new Set(allProjects.map((p) => p.name)),
      priority: 50,
      timestamp: Date.now(),
    });
  });

  server.onMessage("test-run-request", async (payload: any) => {
    const { testIds } = payload;
    console.log(
      `[Core Engine] Manual test run requested for ${testIds.length} tests`,
    );

    executionQueue.enqueue({
      testFiles: new Set(testIds),
      projectNames: new Set(),
      priority: 1000,
      timestamp: Date.now(),
    });
  });

  // Return the port and server, plus a cleanup function
  return {
    port,
    server,
    cleanup: async () => {
      await watcher.stop();
      server.stop();
    },
  };
}

// If run directly as a script (CLI mode), start the engine
if (require.main === module) {
  const workspaceRoot = process.cwd();
  startCoreEngine(workspaceRoot)
    .then(({ port }) => {
      console.log(`[Core Engine] Engine started on port ${port}`);
    })
    .catch((err) => {
      console.error("[Core Engine] Failed to start:", err);
      process.exit(1);
    });
}
