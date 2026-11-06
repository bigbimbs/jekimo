import { gunzipSync } from "node:zlib";
import type { IngestRequest } from "@jekimo/event-schema";
import {
  type DropInfo,
  init,
  type JekimoClient,
  type JekimoError,
  type JekimoOptions,
  type TransportRequest,
  type TransportResponse,
} from "../src/index.js";

/** Synthetic ingestion key in the documented format. Not a real credential. */
export const KEY_ID = "01JBQ4Z3H8X9";
export const SECRET = "wq7m2k9f4t8v1x3z6b5n8c2d7g4h1j5r";
export const KEY = `jk_${KEY_ID}_${SECRET}`;
export const BASE_URL = "https://jekimo.example.com";

export interface RecordedRequest {
  url: string;
  request: TransportRequest;
  /** Decoded request body. */
  body: IngestRequest;
  /** Raw bytes on the wire. */
  wireBytes: number;
  at: number;
}

export type Responder = (req: RecordedRequest, index: number) => TransportResponse | Promise<TransportResponse>;

export function response(
  status: number,
  body: unknown = undefined,
  headers: Record<string, string> = {},
): TransportResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** A 202 that accepts every event in the request. */
export function acceptAll(req: RecordedRequest): TransportResponse {
  return response(202, { accepted: req.body.events.map((e) => e.event_id), rejected: [] });
}

export function decodeBody(request: TransportRequest): IngestRequest {
  const raw =
    typeof request.body === "string"
      ? request.body
      : (request.headers["Content-Encoding"] === "gzip"
          ? gunzipSync(request.body)
          : Buffer.from(request.body)
        ).toString("utf8");
  return JSON.parse(raw) as IngestRequest;
}

export interface Harness {
  client: JekimoClient;
  requests: RecordedRequest[];
  errors: JekimoError[];
  drops: DropInfo[];
  debugLines: string[];
}

export function harness(options: Partial<JekimoOptions> = {}, responder: Responder = acceptAll): Harness {
  const requests: RecordedRequest[] = [];
  const errors: JekimoError[] = [];
  const drops: DropInfo[] = [];
  const debugLines: string[] = [];
  const client = init({
    baseUrl: BASE_URL,
    ingestionKey: KEY,
    flushOnExit: false,
    transport: async (url, request) => {
      const recorded: RecordedRequest = {
        url,
        request,
        body: decodeBody(request),
        wireBytes: typeof request.body === "string" ? Buffer.byteLength(request.body) : request.body.byteLength,
        at: Date.now(),
      };
      requests.push(recorded);
      return responder(recorded, requests.length - 1);
    },
    onError: (e) => errors.push(e),
    onDrop: (d) => drops.push(d),
    debug: (line) => debugLines.push(line),
    ...options,
  });
  return { client, requests, errors, drops, debugLines };
}

/** Lets pending microtasks and zero-delay work run under real timers. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
