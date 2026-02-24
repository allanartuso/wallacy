import "reflect-metadata";
import Container from "typedi";
import { ExtensionContext } from "vscode";
import { IPCServer, startCoreEngine } from "./core-engine";
import { SmartStartCommand } from "./smart-start-command";
import { VsCodeService } from "./vs-code.service";

let engine:
  | {
      port: number;
      server: IPCServer;
      cleanup: () => Promise<void>;
    }
  | undefined;

export async function activate(context: ExtensionContext) {
  const vsCodeService = Container.get(VsCodeService);
  const outputChannel = vsCodeService.setupOutputChanel();
  context.subscriptions.push(outputChannel);

  vsCodeService.appendLine(
    'Congratulations, your extension "wallacy" is now active!',
  );

  const engineInitializer = async () => {
    vsCodeService.appendLine("[Extension] Starting Core Engine...");
    try {
      const workspaceRoot = vsCodeService.getWorkspaceRoot();
      if (!workspaceRoot) {
        throw new Error("no workspaceRoot");
      }

      engine = await startCoreEngine(workspaceRoot);
      vsCodeService.appendLine(
        `[Extension] Core Engine started on port ${engine.port}`,
      );
      return engine;
    } catch (error: any) {
      throw new Error(`Failed to load core-engine: ${error?.message}`);
    }
  };

  engine = engine || (await engineInitializer());
  const smartStartCommand = Container.get(SmartStartCommand);

  const commands = [
    vsCodeService.registerCommand("wallacy.helloWorld", () => {
      vsCodeService.showInformationMessage("Hello World from Wallacy!");
    }),
    vsCodeService.registerCommand("wallacy.smartStart", () => {
      vsCodeService.appendLine(`[Extension] smartStart started`);
      smartStartCommand.execute();
    }),
    vsCodeService.registerCommand("wallacy.stopEngine", async () => {
      smartStartCommand.dispose();
      if (engine) {
        await engine.cleanup();
        engine = undefined;
      }
    }),
  ];

  context.subscriptions.push(...commands);
}

export function deactivate() {}
