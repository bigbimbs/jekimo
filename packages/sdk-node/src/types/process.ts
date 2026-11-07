import type { JekimoClient } from "./client.js";

export interface CaptureUnhandledOptions {
  /** Defaults to the client from the most recent `init`. */
  client?: JekimoClient;
  /** How long to wait for delivery before the process crashes, in milliseconds. Default 2,000. */
  timeoutMs?: number;
}
