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
