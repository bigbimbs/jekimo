import type { JekimoClient } from "./types/client.js";
import type { FastifyTraceHooks, FastifyTraceReply, FastifyTraceRequest } from "./types/integrations.js";
import type { SpanHandle } from "./types/tracing.js";

export function createFastifyTracingHooks(client: JekimoClient): FastifyTraceHooks {
  const spans = new WeakMap<FastifyTraceRequest, SpanHandle>();
  function finish(request: FastifyTraceRequest, status: "ok" | "error") {
    const span = spans.get(request);
    spans.delete(request);
    try {
      span?.end(status);
    } catch {}
  }
  return {
    onRequest(request, _reply, done) {
      if (!client.enabled || !request.routeOptions.url || spans.has(request)) return done();
      // Only the framework's static route template is used, never the request URL.
      const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)$/.test(request.method)
        ? request.method
        : "HTTP";
      const span = client.startSpan({ name: `${method} ${request.routeOptions.url}`, operation: "http.server" });
      spans.set(request, span);
      span.run(() => done());
    },
    onResponse(request: FastifyTraceRequest, reply: FastifyTraceReply, done: () => void) {
      finish(request, reply.statusCode >= 500 ? "error" : "ok");
      done();
    },
    onTimeout(request, _reply, done) {
      finish(request, "error");
      done();
    },
    onRequestAbort(request, done) {
      finish(request, "error");
      done();
    },
  };
}
