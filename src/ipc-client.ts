import { Service } from "typedi";

/**
 * IPCClient — Handles communication with the Core Engine.
 */
@Service()
export class IPCClient {
  /**
   * Register a callback for a specific message type.
   */
  on(type: string, callback: (payload: any) => void) {}

  send(type: string, payload: unknown) {}

  disconnect() {}
}
