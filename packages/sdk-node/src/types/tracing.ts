export interface TraceOptions {
  /** Static route or operation name; never a raw URL containing user data. */
  name: string;
  /** Explicit trusted correlation input. Invalid IDs start a new trace. */
  traceId?: string;
  parentSpanId?: string;
}
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
}

export interface SpanOptions extends TraceOptions {
  /** Static operation category, for example http.server or task. */
  operation?: string;
}
export interface SpanHandle {
  readonly context: TraceContext;
  run<T>(callback: (context: TraceContext) => T): T;
  /** Idempotent completion; does not send over the network synchronously. */
  end(status?: "ok" | "error"): void;
}
