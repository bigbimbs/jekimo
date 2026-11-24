import { Client } from "./client.js";
import { DEFAULT_UNHANDLED_TIMEOUT_MS, NAME, VERSION } from "./constants/index.js";
import { createCronMonitor as createCronMonitorClient } from "./cron.js";
import { installUnhandledHandlers } from "./node.js";
import { instrumentPostgres as instrumentPg } from "./postgres.js";
import type { CaptureOptions, JekimoClient, JekimoOptions } from "./types/client.js";
import type { CronMonitorClient, CronMonitorOptions } from "./types/cron.js";
import type { DatabaseQuery, DatabaseQueryOptions } from "./types/database.js";
import type { PartialEnvelope, Severity } from "./types/event.js";
import type { PostgresInstrumentation, PostgresInstrumentationOptions, PostgresTarget } from "./types/postgres.js";
import type { CaptureUnhandledOptions } from "./types/process.js";

// Public types are re-exported from these files one by one, not from
// ./types/index.js: scripts/build.mjs inlines every file named here into the
// published index.d.ts, and ./types/delivery.ts must stay internal.
export type { CaptureOptions, ClientStats, JekimoClient, JekimoOptions } from "./types/client.js";
export type { DropInfo, DropReason, JekimoError, JekimoErrorCode } from "./types/errors.js";
export type {
  AttributeValue,
  EventEnvelope,
  EventKind,
  ExceptionInfo,
  PartialEnvelope,
  Severity,
  ValidationIssue,
} from "./types/event.js";
export type { CaptureUnhandledOptions } from "./types/process.js";
export type { Transport, TransportRequest, TransportResponse } from "./types/transport.js";

export const SDK_NAME: string = NAME;
export const SDK_VERSION: string = VERSION;

let current: JekimoClient | undefined;

/** Creates a client and makes it the target of the top-level capture functions. */
export function init(options: JekimoOptions): JekimoClient {
  current = new Client(options);
  return current;
}

/** The client created by the most recent `init`, if any. */
export function getClient(): JekimoClient | undefined {
  return current;
}

export function captureException(error: unknown, options?: CaptureOptions): string | undefined {
  return current?.captureException(error, options);
}

export function captureMessage(message: string, severity?: Severity, options?: CaptureOptions): string | undefined {
  return current?.captureMessage(message, severity, options);
}

export function log(severity: Severity, message: string, attributes?: Record<string, unknown>): string | undefined {
  return current?.log(severity, message, attributes);
}

export function captureEvent(event: PartialEnvelope): string | undefined {
  return current?.captureEvent(event);
}

export function flush(timeoutMs?: number): Promise<boolean> {
  return current ? current.flush(timeoutMs) : Promise.resolve(true);
}

export function close(timeoutMs?: number): Promise<boolean> {
  return current ? current.close(timeoutMs) : Promise.resolve(true);
}

/**
 * Reports `uncaughtException` and `unhandledRejection` as fatal exceptions
 * without changing what Node does with them: when no other handler is
 * installed the process still crashes with the original error, after a
 * bounded wait for delivery. Returns a function that removes the handlers.
 */
export function captureUnhandled(options: CaptureUnhandledOptions = {}): () => void {
  return installUnhandledHandlers(() => options.client ?? current, options.timeoutMs ?? DEFAULT_UNHANDLED_TIMEOUT_MS);
}
export function createCronMonitor(options: CronMonitorOptions): CronMonitorClient {
  return createCronMonitorClient(options);
}
export type { CronMonitorClient, CronMonitorOptions } from "./types/cron.js";

export type { DatabaseQuery, DatabaseQueryOptions } from "./types/database.js";
export function captureQuery(query: DatabaseQuery): string | undefined {
  return current?.captureQuery(query);
}
export async function traceQuery<T>(options: DatabaseQueryOptions, run: () => T | PromiseLike<T>): Promise<T> {
  return current ? current.traceQuery(options, run) : await run();
}

export type { PostgresInstrumentation, PostgresInstrumentationOptions, PostgresTarget } from "./types/postgres.js";
export type { TraceContext, TraceOptions } from "./types/tracing.js";
export function instrumentPostgres(
  target: PostgresTarget,
  options: PostgresInstrumentationOptions,
): PostgresInstrumentation {
  return instrumentPg(target, options);
}
