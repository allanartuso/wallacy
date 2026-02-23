import { WebSocketServer, WebSocket } from "ws";
import { IPCMessageType, IPCEnvelope } from "../../shared-types";

/**
 * IPCServer — Handles WebSocket communication between
 * the core engine and the VS Code extension.
 */
export class IPCServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private messageSequence = 0;
  private handlers = new Map<
    IPCMessageType,
    (payload: any, ws: WebSocket) => void
  >();
  private stateCache = new Map<IPCMessageType, IPCEnvelope<any>>();
  private testResultsCache = new Map<string, IPCEnvelope<any>>();

  /**
   * Register a handler for a specific message type.
   */
  onMessage<T>(
    type: IPCMessageType,
    handler: (payload: T, ws: WebSocket) => void,
  ): void {
    this.handlers.set(type, handler);
  }

  /**
   * Start the IPC server on a dynamic or specific port.
   */
  start(port: number = 0): number {
    this.wss = new WebSocketServer({ port });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);

      // Replay last known state (status, discovery, response)
      for (const lastEnvelope of this.stateCache.values()) {
        ws.send(JSON.stringify(lastEnvelope));
      }

      // Replay all test results
      for (const resultEnvelope of this.testResultsCache.values()) {
        ws.send(JSON.stringify(resultEnvelope));
      }

      ws.on("close", () => {
        this.clients.delete(ws);
      });

      ws.on("message", (data) => {
        this.handleIncoming(ws, data.toString());
      });
    });

    const address = this.wss.address();
    if (typeof address === "string") {
      return parseInt(address.split(":").pop() ?? "0");
    }
    return address?.port ?? 0;
  }

  /**
   * Broadcast a message to all connected clients.
   */
  broadcast<T>(type: IPCMessageType, payload: T): void {
    const envelope: IPCEnvelope<T> = {
      id: `${Date.now()}-${Math.random()}`, // TODO: improve it
      seq: ++this.messageSequence,
      type,
      payload,
      timestamp: Date.now(),
    };

    const data = JSON.stringify(envelope);

    // Cache persistent state types
    if (
      type === "engine-status" ||
      type === "smart-start-response" ||
      type === "test-discovery"
    ) {
      this.stateCache.set(type, envelope);
    }

    // Cache all test results (by testId to avoid duplicates)
    if (type === "test-result") {
      const testId = (payload as any).testId;
      if (testId) {
        this.testResultsCache.set(testId, envelope);
      }
    }

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Stop the server and disconnect all clients.
   */
  stop(): void {
    this.wss?.close();
    this.clients.clear();
  }

  private handleIncoming(ws: WebSocket, data: string): void {
    try {
      console.log("[Server] handleIncoming");
      const envelope = JSON.parse(data) as IPCEnvelope;
      const handler = this.handlers.get(envelope.type as IPCMessageType);

      if (handler) {
        handler(envelope.payload, ws);
      } else {
        console.warn(`[IPC] No handler registered for type: ${envelope.type}`);
      }
    } catch (e) {
      console.error("[IPC] Failed to parse message", e);
    }
  }
}
