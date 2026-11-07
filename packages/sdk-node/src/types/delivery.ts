// Internal to the SDK. Kept out of the public type files because it references
// @jekimo/event-schema, which the published declarations must not import.

import type { IngestResponse } from "@jekimo/event-schema";

export type AttemptResult =
  | { outcome: "success"; response: IngestResponse | undefined }
  | { outcome: "retry"; reason: string; status?: number; serverCode?: string; retryAfterMs?: number }
  | { outcome: "fail"; reason: string; status: number; serverCode?: string };

export interface PreparedBody {
  body: string | Uint8Array;
  gzip: boolean;
}
