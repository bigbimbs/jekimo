/**
 * One HTTP attempt against the ingestion endpoint, and the retry schedule.
 * Normative text: docs/ingestion-protocol.md, "Request", "Responses", and
 * "SDK requirements".
 */

import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { IngestResponse } from "@jekimo/event-schema";
import type { Transport, TransportResponse } from "./index.js";
import { USER_AGENT } from "./version.js";

const gzipAsync = promisify(gzip);

/** Bodies larger than this are gzip-compressed. */
export const GZIP_THRESHOLD_BYTES = 8 * 1024;
/** Give up on a batch after this many attempts. */
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 60_000;
/** Upper bound on one request, so a stalled connection cannot hold the sender forever. */
export const REQUEST_TIMEOUT_MS = 10_000;

export type AttemptResult =
  | { outcome: "success"; response: IngestResponse | undefined }
  | { outcome: "retry"; reason: string; status?: number; serverCode?: string; retryAfterMs?: number }
  | { outcome: "fail"; reason: string; status: number; serverCode?: string };

export interface PreparedBody {
  body: string | Uint8Array;
  gzip: boolean;
}

export async function prepareBody(json: string, rawBytes: number): Promise<PreparedBody> {
  if (rawBytes <= GZIP_THRESHOLD_BYTES) return { body: json, gzip: false };
  const compressed = await gzipAsync(json);
  return { body: new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength), gzip: true };
}

export function requestHeaders(ingestionKey: string, gzipped: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ingestionKey}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (gzipped) headers["Content-Encoding"] = "gzip";
  return headers;
}

/** Parses `Retry-After` as delta-seconds or an HTTP date. Returns milliseconds, or undefined. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * Delay before the next attempt after `attempt` attempts have failed:
 * `Retry-After` when the server sent one, otherwise full jitter over
 * min(60 s, 1 s × 2^(attempt − 1)).
 */
export function retryDelay(
  attempt: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorBody(body: unknown): { code?: string; retryAfterMs?: number } {
  if (typeof body !== "object" || body === null) return {};
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return {};
  const { code, retry_after } = error as { code?: unknown; retry_after?: unknown };
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof retry_after === "number" && Number.isFinite(retry_after) && retry_after >= 0
      ? { retryAfterMs: Math.round(retry_after * 1000) }
      : {}),
  };
}

function ingestResponse(body: unknown): IngestResponse | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { accepted, rejected } = body as { accepted?: unknown; rejected?: unknown };
  if (!Array.isArray(accepted) || !Array.isArray(rejected)) return undefined;
  return body as IngestResponse;
}

async function readBody(response: TransportResponse): Promise<unknown> {
  try {
    return parseJson(await response.text());
  } catch {
    return undefined;
  }
}

/** Classifies one HTTP response by the rules in "Request-level errors". */
export async function classifyResponse(response: TransportResponse): Promise<AttemptResult> {
  const { status } = response;
  const body = await readBody(response);
  if (status >= 200 && status < 300) {
    return { outcome: "success", response: ingestResponse(body) };
  }
  const { code, retryAfterMs: bodyRetryAfter } = errorBody(body);
  const serverCode = code !== undefined ? { serverCode: code } : {};
  if (status === 429 || status >= 500) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after")) ?? bodyRetryAfter;
    return {
      outcome: "retry",
      reason: `HTTP ${status}${code ? ` ${code}` : ""}`,
      status,
      ...serverCode,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  return { outcome: "fail", reason: `HTTP ${status}${code ? ` ${code}` : ""}`, status, ...serverCode };
}

/** Sends one prepared body. Network errors and timeouts are retryable. */
export async function attempt(
  transport: Transport,
  url: string,
  headers: Record<string, string>,
  body: string | Uint8Array,
  signal: AbortSignal,
): Promise<AttemptResult> {
  let response: TransportResponse;
  try {
    response = await transport(url, { method: "POST", headers, body, signal, redirect: "manual" });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    if (name === "AbortError" || name === "TimeoutError") return { outcome: "retry", reason: "request timed out" };
    const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
    const detail = error instanceof Error ? `: ${error.message}${typeof cause === "string" ? ` (${cause})` : ""}` : "";
    return { outcome: "retry", reason: `network error${detail}` };
  }
  try {
    return await classifyResponse(response);
  } catch {
    return { outcome: "retry", reason: "network error while reading the response" };
  }
}
