import { expect, it } from "vitest";
import { instrumentPostgres } from "../src/index.js";
import { harness } from "./helpers.js";

it("instruments promise queries without changing arguments, results or errors", async () => {
  const h = harness();
  const result = { rows: [{ secret: "synthetic-row" }] },
    error = new Error("synthetic-sql-error");
  const calls: unknown[][] = [];
  const target = {
    query(...args: unknown[]) {
      expect(this).toBe(target);
      calls.push(args);
      return args[0] === "failure" ? Promise.reject(error) : Promise.resolve(result);
    },
  };
  const original = target.query;
  const handle = instrumentPostgres(target, { client: h.client, name: "invoices.list" });
  const values = ["synthetic-password"];
  const config = { text: "synthetic SQL", values };
  await h.client.withTrace({ name: "GET /invoices" }, async (context) => {
    expect(await target.query(config)).toBe(result);
    await expect(target.query("failure")).rejects.toBe(error);
    expect(h.client.getTraceContext()?.traceId).toBe(context.traceId);
  });
  expect(calls[0]?.[0]).toBe(config);
  expect(instrumentPostgres(target, { client: h.client })).toBe(handle);
  handle.restore();
  expect(target.query).toBe(original);
  expect(handle.installed).toBe(false);
  await target.query("after restore");
  await h.client.close();
  const events = h.requests.flatMap((r) => r.body.events);
  expect(events.map((e) => e.database?.status)).toEqual(["ok", "error"]);
  expect(events.every((e) => Boolean(e.context?.trace_id))).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/synthetic-password|synthetic SQL|synthetic-row|synthetic-sql-error/);
});
it("preserves callback return/receiver and binds delayed callbacks to their request", async () => {
  const h = harness();
  const receiver = { name: "synthetic" };
  let complete: ((...args: unknown[]) => unknown) | undefined;
  const target = {
    query(_text: string, callback: (...args: unknown[]) => unknown) {
      complete = callback;
      return undefined;
    },
  };
  const handle = instrumentPostgres(target, { client: h.client });
  let traceId = "";
  let returned: unknown;
  h.client.withTrace({ name: "callback" }, (ctx) => {
    traceId = ctx.traceId;
    returned = target.query("synthetic SQL", function (this: unknown, error, result) {
      expect(this).toBe(receiver);
      expect(error).toBeNull();
      expect(result).toBe(42);
      expect(h.client.getTraceContext()?.traceId).toBe(traceId);
      h.client.log("info", "callback log");
      return 7;
    });
  });
  expect(returned).toBeUndefined();
  expect(complete?.call(receiver, null, 42)).toBe(7);
  handle.restore();
  await h.client.close();
  const events = h.requests.flatMap((r) => r.body.events);
  expect(events).toHaveLength(2);
  expect(events.every((e) => e.context?.trace_id === traceId)).toBe(true);
});
it("passes through streams, protects other wrappers and refuses cross-client installation", async () => {
  const h = harness(),
    other = harness();
  const result = { stream: true };
  const target = {
    query(_config: unknown) {
      return result;
    },
  };
  const original = target.query;
  const handle = instrumentPostgres(target, { client: h.client });
  expect(instrumentPostgres(target, { client: other.client }).installed).toBe(false);
  expect(target.query({ submit() {} })).toBe(result);
  expect(target.query({ callback() {} })).toBe(result);
  const later = () => result;
  target.query = later;
  handle.restore();
  expect(target.query).toBe(later);
  const frozen = Object.freeze({ query: original });
  expect(instrumentPostgres(frozen, { client: h.client }).installed).toBe(false);
  await Promise.all([h.client.close(), other.client.close()]);
  expect(h.requests).toHaveLength(0);
});
it("keeps synchronous failures and callback exceptions intact", async () => {
  const h = harness();
  const error = { synthetic: "error" };
  const target = {
    query() {
      throw error;
    },
  };
  const handle = instrumentPostgres(target, { client: h.client });
  expect(() => target.query()).toThrow();
  handle.restore();
  const callbackTarget = {
    query(_sql: string, callback: (error: null, value: number) => unknown) {
      return callback(null, 1);
    },
  };
  const callbackHandle = instrumentPostgres(callbackTarget, { client: h.client });
  try {
    callbackTarget.query("synthetic SQL", () => {
      throw error;
    });
    throw Error("callback was swallowed");
  } catch (e) {
    expect(e).toBe(error);
  }
  callbackHandle.restore();
  await h.client.close();
  expect(h.requests.flatMap((r) => r.body.events).map((e) => e.database?.status)).toEqual(["error", "ok"]);
});
