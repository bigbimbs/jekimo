import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { SPAN_ID_PATTERN, TRACE_ID_PATTERN } from "./constants/tracing.js";
import type { TraceContext, TraceOptions } from "./types/tracing.js";
export class TraceScope {
  private readonly storage = new AsyncLocalStorage<TraceContext>();
  current(): TraceContext | undefined {
    const value = this.storage.getStore();
    return value ? { ...value } : undefined;
  }
  run<T>(options: TraceOptions, callback: (context: TraceContext) => T): T {
    const parent = this.storage.getStore();
    const explicit = options.traceId !== undefined;
    const traceId =
      options.traceId !== undefined && TRACE_ID_PATTERN.test(options.traceId)
        ? options.traceId
        : !explicit && parent
          ? parent.traceId
          : randomBytes(16).toString("hex");
    const parentSpanId = explicit
      ? SPAN_ID_PATTERN.test(options.parentSpanId ?? "") && TRACE_ID_PATTERN.test(options.traceId ?? "")
        ? options.parentSpanId
        : undefined
      : parent?.spanId;
    const name =
      typeof options.name === "string" && options.name.length > 0 && options.name.length <= 128
        ? options.name
        : "request";
    const context: TraceContext = Object.freeze({
      traceId,
      spanId: randomBytes(8).toString("hex"),
      name,
      ...(parentSpanId && { parentSpanId }),
    });
    return this.storage.run(context, () => callback(context));
  }
  fields(query = false): Record<string, string> {
    const context = this.storage.getStore();
    if (!context) return {};
    const parentSpanId = query ? context.spanId : context.parentSpanId;
    return {
      trace_id: context.traceId,
      span_id: query ? randomBytes(8).toString("hex") : context.spanId,
      trace_name: context.name,
      ...(parentSpanId && { parent_span_id: parentSpanId }),
    };
  }
}
