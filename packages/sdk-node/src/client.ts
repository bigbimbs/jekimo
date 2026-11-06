/**
 * The client: builds envelopes on the caller's stack, queues them in memory,
 * and sends them from a single background sender. Normative text:
 * docs/ingestion-protocol.md, "SDK requirements".
 *
 * Nothing a capture method does waits on the network. Sends start from
 * timers; every timer is unref'd so the SDK never keeps a process alive.
 */

import {
  INGEST_PATH,
  type IngestResponse,
  LIMITS,
  normalizeSampleRate,
  parseIngestionKey,
  SCHEMA_VERSION,
  shouldKeepEvent,
  validateEvent,
} from "@jekimo/event-schema";
import {
  byteLength,
  exceptionFrom,
  fitEvent,
  normalizeAttributes,
  normalizeContext,
  shortString,
  truncate,
} from "./envelope.js";
import type {
  CaptureOptions,
  ClientStats,
  DropReason,
  EventEnvelope,
  JekimoClient,
  JekimoError,
  JekimoOptions,
  PartialEnvelope,
  Severity,
  Transport,
} from "./index.js";
import { createRedactor, type KeyRedactor } from "./redact.js";
import { attempt, MAX_ATTEMPTS, prepareBody, REQUEST_TIMEOUT_MS, requestHeaders, retryDelay } from "./transport.js";
import { createUlidGenerator } from "./ulid.js";
import { NAME, VERSION } from "./version.js";

export const DEFAULTS = {
  maxQueueSize: 1000,
  flushIntervalMs: 2000,
  maxBatchEvents: LIMITS.MAX_BATCH_EVENTS,
  maxBatchBytes: 512 * 1024,
  shutdownTimeoutMs: 2000,
} as const;

/** Bytes of `{"sent_at":"<24 chars>","events":[]}` plus slack. */
const BODY_OVERHEAD_BYTES = 64;

interface QueuedEvent {
  id: string;
  json: string;
  bytes: number;
}

interface Connection {
  url: string;
  key: string;
  secret: string;
  insecure: boolean;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function resolveConnection(options: JekimoOptions): Connection | string {
  let base: URL;
  let key: string | undefined;
  if (options.dsn !== undefined) {
    try {
      base = new URL(options.dsn);
    } catch {
      return "dsn is not a valid URL";
    }
    if (base.password !== "") return "dsn must have the form https://<ingestion key>@<host>";
    key = decodeURIComponent(base.username);
    base.username = "";
  } else if (options.baseUrl !== undefined) {
    try {
      base = new URL(options.baseUrl);
    } catch {
      return "baseUrl is not a valid URL";
    }
    if (base.username !== "" || base.password !== "") return "baseUrl must not contain credentials; use ingestionKey";
    key = options.ingestionKey;
  } else {
    return "set dsn, or baseUrl and ingestionKey";
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return "the ingestion URL must use https";
  const parsed = parseIngestionKey(key);
  if (!parsed || key === undefined) return "the ingestion key is missing or malformed (expected jk_<key_id>_<secret>)";
  const path = base.pathname.replace(/\/+$/, "");
  return {
    url: `${base.origin}${path}${INGEST_PATH}`,
    key,
    secret: parsed.secret,
    insecure: base.protocol === "http:" && !LOOPBACK.has(base.hostname) && !base.hostname.startsWith("127."),
  };
}

function positiveInt(value: number | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

interface BuildInput {
  kind: EventEnvelope["kind"];
  severity: Severity;
  message: string;
  timestamp?: string | Date | undefined;
  service?: string | undefined;
  environment?: string | undefined;
  release?: string | undefined;
  fingerprint?: string | undefined;
  exception?: EventEnvelope["exception"] | undefined;
  context?: Record<string, unknown> | undefined;
  attributes?: Record<string, unknown> | undefined;
}

export class Client implements JekimoClient {
  private readonly options: JekimoOptions;
  private readonly connection: Connection | undefined;
  private readonly transport: Transport;
  private readonly redact: KeyRedactor;
  private readonly nextId = createUlidGenerator();
  private readonly sampleRate: number;
  private readonly maxQueueSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBatchEvents: number;
  private readonly maxBatchBytes: number;
  private readonly shutdownTimeoutMs: number;
  private readonly baseContext: Record<string, string>;

  private active: boolean;
  private stopped = false;
  private queue: QueuedEvent[] = [];
  private queuedBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private kickTimer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> | undefined;
  private currentBatch: QueuedEvent[] | undefined;
  private inflight: AbortController | undefined;
  private wake: (() => void) | undefined;
  private exitFlushDone = false;
  private readonly reportedFailures = new Set<string>();
  private readonly counters = { sent: 0, rejected: 0, dropped: 0 };
  private readonly onBeforeExit = (): void => this.exitFlush();
  private readonly onExit = (): void => this.reportUnsent();

  constructor(options: JekimoOptions) {
    this.options = options;
    this.transport =
      options.transport ??
      (typeof globalThis.fetch === "function"
        ? (url, request) => globalThis.fetch(url, request as RequestInit)
        : (undefined as unknown as Transport));
    this.redact = createRedactor(options.redactKeys, options.redactPatterns);
    this.sampleRate = normalizeSampleRate(options.sampleRate ?? 1);
    this.maxQueueSize = positiveInt(options.maxQueueSize, DEFAULTS.maxQueueSize);
    this.flushIntervalMs = positiveInt(options.flushIntervalMs, DEFAULTS.flushIntervalMs);
    this.maxBatchEvents = positiveInt(options.maxBatchEvents, DEFAULTS.maxBatchEvents, LIMITS.MAX_BATCH_EVENTS);
    this.maxBatchBytes = positiveInt(
      options.maxBatchBytes,
      DEFAULTS.maxBatchBytes,
      LIMITS.MAX_BATCH_BYTES - BODY_OVERHEAD_BYTES,
    );
    this.shutdownTimeoutMs = positiveInt(options.shutdownTimeoutMs, DEFAULTS.shutdownTimeoutMs);
    this.baseContext = { runtime: `node/${process.versions.node}`, ...options.context };

    const connection = resolveConnection(options);
    if (typeof connection === "string") {
      this.active = false;
      this.report({ code: "invalid_config", message: `${connection}; the client is disabled` });
      return;
    }
    if (typeof this.transport !== "function") {
      this.active = false;
      this.report({ code: "invalid_config", message: "no fetch implementation is available; pass transport" });
      return;
    }
    this.connection = connection;
    this.active = true;
    if (connection.insecure) {
      this.report({
        code: "insecure_transport",
        message: "the ingestion URL uses plain http on a non-loopback host; the ingestion key is sent unencrypted",
      });
    }
    if (options.flushOnExit !== false) {
      process.on("beforeExit", this.onBeforeExit);
      process.on("exit", this.onExit);
    }
    this.debug(`initialised: ${connection.url}, ${NAME}/${VERSION}`);
  }

  get enabled(): boolean {
    return this.active;
  }

  captureException(error: unknown, options: CaptureOptions = {}): string | undefined {
    return this.safely(() => {
      const { exception, message } = exceptionFrom(error);
      return this.capture({
        kind: "exception",
        severity: options.severity ?? "error",
        message: options.message ?? message,
        fingerprint: options.fingerprint,
        exception,
        context: options.context,
        attributes: options.attributes,
      });
    });
  }

  captureMessage(message: string, severity: Severity = "info", options: CaptureOptions = {}): string | undefined {
    return this.safely(() =>
      this.capture({
        kind: "event",
        severity: options.severity ?? severity,
        message: options.message ?? message,
        fingerprint: options.fingerprint,
        context: options.context,
        attributes: options.attributes,
      }),
    );
  }

  log(severity: Severity, message: string, attributes?: Record<string, unknown>): string | undefined {
    return this.safely(() => this.capture({ kind: "log", severity, message, attributes }));
  }

  captureEvent(event: PartialEnvelope): string | undefined {
    return this.safely(() =>
      this.capture({
        ...event,
        kind: event.kind ?? "event",
        severity: event.severity ?? "info",
      }),
    );
  }

  stats(): ClientStats {
    return { queued: this.queue.length, ...this.counters };
  }

  async flush(timeoutMs: number = this.shutdownTimeoutMs): Promise<boolean> {
    if (this.queue.length === 0 && !this.sending) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      timer.unref?.();
    });
    try {
      return await Promise.race([this.drain(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(timeoutMs: number = this.shutdownTimeoutMs): Promise<boolean> {
    if (this.stopped) return true;
    this.active = false;
    const drained = await this.flush(timeoutMs);
    this.stopped = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.kickTimer);
    this.wake?.();
    this.inflight?.abort();
    process.off("beforeExit", this.onBeforeExit);
    process.off("exit", this.onExit);
    // A transport that ignores the abort signal must not hang close().
    if (this.sending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.sending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 50);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
    if (this.queue.length > 0) this.drop("shutdown", this.queue.length);
    this.queue = [];
    this.queuedBytes = 0;
    this.debug(`closed (${drained ? "drained" : "timed out"})`);
    return drained;
  }

  // ---- building ----------------------------------------------------------

  private safely(fn: () => string | undefined): string | undefined {
    if (!this.active) return undefined;
    try {
      return fn();
    } catch (error) {
      this.report({
        code: "invalid_event",
        message: `could not build event: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  }

  private capture(input: BuildInput): string | undefined {
    const { options } = this;
    const timestamp =
      input.timestamp instanceof Date ? input.timestamp.toISOString() : (input.timestamp ?? new Date().toISOString());
    const event: EventEnvelope = {
      schema_version: SCHEMA_VERSION,
      event_id: this.nextId(),
      timestamp,
      kind: input.kind,
      severity: input.severity,
      message: truncate(String(input.message), LIMITS.MAX_MESSAGE_CHARS),
    };

    if (!shouldKeepEvent(event, this.sampleRate)) {
      this.debug(`sampled out ${event.event_id}`);
      return undefined;
    }

    const service = shortString(input.service ?? options.service, LIMITS.MAX_SHORT_STRING_CHARS);
    const environment = shortString(input.environment ?? options.environment, LIMITS.MAX_SHORT_STRING_CHARS);
    const release = shortString(input.release ?? options.release, LIMITS.MAX_SHORT_STRING_CHARS);
    const fingerprint = shortString(input.fingerprint, LIMITS.MAX_FINGERPRINT_CHARS);
    if (service !== undefined) event.service = service;
    if (environment !== undefined) event.environment = environment;
    if (release !== undefined) event.release = release;
    if (fingerprint !== undefined) event.fingerprint = fingerprint;
    if (input.exception) {
      const { type, value, stacktrace } = input.exception;
      event.exception = {
        type: typeof type === "string" ? truncate(type, LIMITS.MAX_EXCEPTION_TYPE_CHARS) : String(type),
      };
      if (typeof value === "string") event.exception.value = truncate(value, LIMITS.MAX_EXCEPTION_VALUE_CHARS);
      if (typeof stacktrace === "string")
        event.exception.stacktrace = truncate(stacktrace, LIMITS.MAX_STACKTRACE_CHARS);
    }
    event.sdk = { name: NAME, version: VERSION };
    if (options.captureContext !== false) {
      const context = normalizeContext({ ...this.baseContext, ...input.context }, this.redact);
      if (context) event.context = context;
    }
    const attributes = normalizeAttributes(input.attributes, this.redact);
    if (attributes) event.attributes = attributes;

    const json = fitEvent(event);
    const result = validateEvent(event, { mode: "ingest" });
    if (!result.ok) {
      this.report({
        code: "invalid_event",
        message: `event ${event.event_id} is invalid: ${result.errors.map((e) => e.message).join("; ")}`,
        eventId: event.event_id,
        issues: result.errors,
      });
      this.drop("invalid_event", 1);
      return undefined;
    }
    this.enqueue({ id: event.event_id, json, bytes: byteLength(json) });
    return event.event_id;
  }

  // ---- queue -------------------------------------------------------------

  private enqueue(item: QueuedEvent): void {
    if (this.queue.length >= this.maxQueueSize) {
      const oldest = this.queue.shift();
      if (oldest) {
        this.queuedBytes -= oldest.bytes;
        this.drop("queue_full", 1);
      }
    }
    this.queue.push(item);
    this.queuedBytes += item.bytes;
    this.exitFlushDone = false;
    this.debug(`queued ${item.id} (${this.queue.length} queued, ${this.queuedBytes} bytes)`);

    if (this.queue.length >= this.maxBatchEvents || this.queuedBytes >= this.maxBatchBytes) {
      this.kick();
    } else if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.pump();
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  /** Starts the sender on a fresh tick, off the caller's stack. */
  private kick(): void {
    if (this.kickTimer !== undefined || this.sending) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      void this.pump();
    }, 0);
    this.kickTimer.unref?.();
  }

  private takeBatch(): QueuedEvent[] {
    const batch: QueuedEvent[] = [];
    let bytes = 0;
    for (let next = this.queue[0]; next !== undefined && batch.length < this.maxBatchEvents; next = this.queue[0]) {
      if (batch.length > 0 && bytes + next.bytes + 1 > this.maxBatchBytes) break;
      this.queue.shift();
      batch.push(next);
      bytes += next.bytes + 1;
      this.queuedBytes -= next.bytes;
    }
    return batch;
  }

  private pump(): Promise<void> {
    if (this.sending) return this.sending;
    if (this.stopped || this.queue.length === 0) return Promise.resolve();
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.sending = (async () => {
      try {
        while (!this.stopped && this.queue.length > 0) {
          const batch = this.takeBatch();
          this.currentBatch = batch;
          await this.deliver(batch);
          this.currentBatch = undefined;
        }
      } catch (error) {
        this.debug(`sender error: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.currentBatch = undefined;
        this.sending = undefined;
      }
    })();
    return this.sending;
  }

  private async drain(): Promise<true> {
    while (!this.stopped && (this.queue.length > 0 || this.sending)) {
      await this.pump();
    }
    return true;
  }

  // ---- delivery ----------------------------------------------------------

  private async deliver(batch: QueuedEvent[]): Promise<void> {
    const { connection } = this;
    if (!connection) return;
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      if (this.stopped) {
        this.drop("shutdown", batch.length);
        return;
      }
      const json = `{"sent_at":"${new Date().toISOString()}","events":[${batch.map((e) => e.json).join(",")}]}`;
      const prepared = await prepareBody(json, byteLength(json));
      const controller = new AbortController();
      this.inflight = controller;
      this.debug(`sending ${batch.length} event(s), attempt ${n}/${MAX_ATTEMPTS}${prepared.gzip ? ", gzip" : ""}`);
      const result = await attempt(
        this.transport,
        connection.url,
        requestHeaders(connection.key, prepared.gzip),
        prepared.body,
        AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      );
      this.inflight = undefined;

      if (result.outcome === "success") {
        this.handleAccepted(batch, result.response);
        return;
      }
      if (result.outcome === "fail") {
        const key = `${result.status}:${result.serverCode ?? ""}`;
        if (!this.reportedFailures.has(key)) {
          this.reportedFailures.add(key);
          this.report({
            code: "request_failed",
            message: `ingestion request failed with ${result.reason}; dropped ${batch.length} event(s) and will not retry`,
            status: result.status,
            ...(result.serverCode !== undefined ? { serverCode: result.serverCode } : {}),
          });
        }
        this.drop("request_failed", batch.length);
        return;
      }
      if (n === MAX_ATTEMPTS) {
        this.report({
          code: "retries_exhausted",
          message: `ingestion failed ${MAX_ATTEMPTS} times (last: ${result.reason}); dropped ${batch.length} event(s)`,
          ...(result.status !== undefined ? { status: result.status } : {}),
          ...(result.serverCode !== undefined ? { serverCode: result.serverCode } : {}),
        });
        this.drop("retries_exhausted", batch.length);
        return;
      }
      if (this.stopped) {
        this.drop("shutdown", batch.length);
        return;
      }
      const delay = retryDelay(n, result.retryAfterMs);
      this.debug(`${result.reason}; retrying in ${delay} ms`);
      await this.sleep(delay);
    }
  }

  private handleAccepted(batch: QueuedEvent[], response: IngestResponse | undefined): void {
    if (!response) {
      this.counters.sent += batch.length;
      this.debug(`sent ${batch.length} event(s)`);
      return;
    }
    this.counters.sent += response.accepted.length;
    this.counters.rejected += response.rejected.length;
    this.debug(`accepted ${response.accepted.length}, rejected ${response.rejected.length}`);
    for (const rejection of response.rejected) {
      const eventId = rejection.event_id ?? batch[rejection.index]?.id;
      const errors = Array.isArray(rejection.errors) ? rejection.errors : [];
      this.report({
        code: "event_rejected",
        message: `server rejected event ${eventId ?? `at index ${rejection.index}`}: ${errors.map((e) => e.message).join("; ")}`,
        ...(eventId !== undefined ? { eventId } : {}),
        issues: errors,
      });
    }
    for (const warning of response.warnings ?? []) {
      this.debug(`server warning for event at index ${warning.index}: ${warning.message}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      const self = this;
      function done(): void {
        clearTimeout(timer);
        self.wake = undefined;
        resolve();
      }
      this.wake = done;
    });
  }

  // ---- process exit ------------------------------------------------------

  /**
   * On `beforeExit` (the event loop is empty), flush once within the shutdown
   * timeout. A request still running at the deadline is aborted so the
   * process can exit; a batch waiting out a backoff does not hold it open.
   */
  private exitFlush(): void {
    if (this.exitFlushDone || this.stopped || (this.queue.length === 0 && !this.sending)) return;
    this.exitFlushDone = true;
    this.debug("process exiting; flushing");
    void this.flush(this.shutdownTimeoutMs).then((drained) => {
      if (!drained) this.inflight?.abort();
    });
  }

  private reportUnsent(): void {
    const unsent = this.queue.length + (this.currentBatch?.length ?? 0);
    if (unsent > 0) this.drop("shutdown", unsent);
  }

  // ---- reporting ---------------------------------------------------------

  private drop(reason: DropReason, count: number): void {
    this.counters.dropped += count;
    this.debug(`dropped ${count} event(s): ${reason}`);
    const hook = this.options.onDrop;
    if (!hook) return;
    try {
      hook({ reason, count });
    } catch {
      // A failing hook must not break the SDK.
    }
  }

  /** Removes the ingestion key and its secret from any text the SDK emits. */
  private scrub(text: string): string {
    const c = this.connection;
    if (!c) return text;
    return text.split(c.key).join("[REDACTED]").split(c.secret).join("[REDACTED]");
  }

  private report(error: JekimoError): void {
    const safe: JekimoError = { ...error, message: this.scrub(error.message) };
    if (error.issues) safe.issues = error.issues.map((issue) => ({ ...issue, message: this.scrub(issue.message) }));
    this.debug(`error ${safe.code}: ${safe.message}`);
    try {
      if (this.options.onError) this.options.onError(safe);
      else console.warn(`[jekimo] ${safe.message}`);
    } catch {
      // A failing hook must not break the SDK.
    }
  }

  private debug(line: string): void {
    const { debug } = this.options;
    if (!debug) return;
    const text = `[jekimo] ${this.scrub(line)}`;
    try {
      if (typeof debug === "function") debug(text);
      else console.debug(text);
    } catch {
      // ignore
    }
  }
}
