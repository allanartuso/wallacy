import * as vscode from "vscode";
import { WebSocket } from "ws";

/**
 * IPCClient — Handles communication with the Core Engine.
 */
export class IPCClient {
  private ws: WebSocket | null = null;
  private outputChannel: vscode.OutputChannel;
  private listeners = new Map<string, ((payload: any) => void)[]>();
  private _port: number | null = null;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  /**
   * Register a callback for a specific message type.
   */
  on(type: string, callback: (payload: any) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)?.push(callback);
  }

  connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${port}`);

      this.ws.on("open", () => {
        this.outputChannel.appendLine(
          `[IPC] Connected to Core Engine on port ${port}`,
        );
        this._port = port;
        resolve();
      });

      this.ws.on("error", (err) => {
        this.outputChannel.appendLine(`[IPC] Connection error: ${err.message}`);
        reject(err);
      });

      this.ws.on("close", () => {
        this.outputChannel.appendLine("[IPC] Disconnected from Core Engine");
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data.toString());
      });
    });
  }

  send(type: string, payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.outputChannel.appendLine("WS opened");
      const stringified = JSON.stringify({
        type,
        payload,
        id: Date.now().toString(),
      });
      this.outputChannel.appendLine(stringified);

      this.ws.send(stringified);
      this.outputChannel.appendLine("ws sent");
    } else {
      this.outputChannel.appendLine("[IPC] Cannot send message, not connected");
    }
  }

  disconnect() {
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  public get port(): number | null {
    return this._port;
  }

  private handleMessage(data: string) {
    try {
      const message = JSON.parse(data);
      this.outputChannel.appendLine(`[IPC ←] ${message.type}`);

      const callbacks = this.listeners.get(message.type);
      if (callbacks) {
        callbacks.forEach((cb) => cb(message.payload));
      }
    } catch (e) {
      this.outputChannel.appendLine(`[IPC] Failed to parse message: ${data}`);
    }
  }
}
