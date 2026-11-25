import type { JekimoClient } from "./client.js";
import type { DatabaseQueryOptions } from "./database.js";

export interface FastifyTraceRequest {
  method: string;
  routeOptions: { url?: string | undefined };
}
export interface FastifyTraceReply {
  statusCode: number;
}
export interface FastifyTraceHooks {
  onRequest(request: FastifyTraceRequest, reply: FastifyTraceReply, done: () => void): void;
  onResponse(request: FastifyTraceRequest, reply: FastifyTraceReply, done: () => void): void;
  onTimeout(request: FastifyTraceRequest, reply: FastifyTraceReply, done: () => void): void;
  onRequestAbort(request: FastifyTraceRequest, done: () => void): void;
}
export interface PrismaTracingOptions {
  client: JekimoClient;
  system: DatabaseQueryOptions["system"];
}
export interface PrismaQueryCall<Args, Result> {
  model: string;
  operation: string;
  args: Args;
  query(args: Args): PromiseLike<Result>;
}
export interface PrismaTracingExtension {
  name: string;
  query: {
    $allModels: {
      $allOperations<Args, Result>(call: PrismaQueryCall<Args, Result>): Promise<Result>;
    };
  };
}
