import { AsyncLocalStorage } from "node:async_hooks";
import type { PostgresInstrumentation, PostgresInstrumentationOptions, PostgresTarget } from "./types/postgres.js";

const installations = new WeakMap<object, { client: object; handle: PostgresInstrumentation }>();
export function instrumentPostgres(
  target: PostgresTarget,
  options: PostgresInstrumentationOptions,
): PostgresInstrumentation {
  const previous = installations.get(target);
  if (previous) return previous.client === options.client ? previous.handle : { installed: false, restore() {} };
  const mutable = target as { query: (...args: unknown[]) => unknown };
  const original = mutable.query;
  const descriptor = Object.getOwnPropertyDescriptor(target, "query");
  let active = true;
  const name = options.name ?? "postgres.query",
    operation = options.operation ?? "other",
    client = options.client;
  function wrapped(this: unknown, ...args: unknown[]): unknown {
    if (!active || !client.enabled) return original.apply(this, args);
    // Query/Submittable streams own their completion lifecycle; do not intercept them.
    const config = args[0];
    if (config && typeof config === "object" && ("submit" in config || "callback" in config))
      return original.apply(this, args);
    const start = performance.now(),
      inContext = AsyncLocalStorage.snapshot();
    let recorded = false;
    const finish = (error: boolean) => {
      if (recorded) return;
      recorded = true;
      try {
        inContext(() =>
          client.captureQuery({
            name,
            system: "postgresql",
            operation,
            duration_ms: performance.now() - start,
            status: error ? "error" : "ok",
          }),
        );
      } catch {}
    };
    const callback = args.at(-1);
    if (typeof callback === "function") {
      args[args.length - 1] = function (this: unknown, ...values: unknown[]) {
        finish(values[0] != null);
        return inContext(() => callback.apply(this, values));
      };
    }
    try {
      const result = original.apply(this, args);
      if (typeof callback === "function") return result;
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        return (result as PromiseLike<unknown>).then(
          (value) => {
            finish(false);
            return value;
          },
          (error: unknown) => {
            finish(true);
            throw error;
          },
        );
      }
      return result;
    } catch (error) {
      finish(true);
      throw error;
    }
  }
  try {
    Object.defineProperty(target, "query", {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: descriptor?.enumerable ?? false,
    });
  } catch {
    return { installed: false, restore() {} };
  }
  const handle: PostgresInstrumentation = {
    get installed() {
      return active;
    },
    restore() {
      active = false;
      installations.delete(target);
      if (mutable.query !== wrapped) return;
      try {
        if (descriptor) Object.defineProperty(target, "query", descriptor);
        else Reflect.deleteProperty(target, "query");
      } catch {}
    },
  };
  installations.set(target, { client, handle });
  return handle;
}
