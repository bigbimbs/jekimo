/**
 * Process-level crash reporting that leaves Node's own behaviour in place.
 *
 * An `uncaughtException` listener normally stops Node from crashing, and an
 * `unhandledRejection` listener stops the default `throw` mode from turning
 * the rejection into a crash. So when these handlers are the only ones
 * installed, they report the error, wait a bounded time for delivery, then
 * hand the error back to Node: the process exits the way it would have
 * without the SDK. When the application has its own handlers, the SDK only
 * reports and lets those handlers decide.
 */

import type { JekimoClient } from "./index.js";

type Mode = "throw" | "strict" | "warn" | "none" | "warn-with-error-code";

/** The effective `--unhandled-rejections` mode. Node's default is `throw`. */
export function unhandledRejectionsMode(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string | undefined = process.env.NODE_OPTIONS,
): Mode {
  const args = [...(nodeOptions?.split(/\s+/) ?? []), ...execArgv];
  let mode: string | undefined;
  args.forEach((arg, i) => {
    if (arg.startsWith("--unhandled-rejections=")) mode = arg.slice("--unhandled-rejections=".length);
    else if (arg === "--unhandled-rejections") mode = args[i + 1];
  });
  return mode === "strict" || mode === "warn" || mode === "none" || mode === "warn-with-error-code" ? mode : "throw";
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** What Node throws for a rejection whose reason is not an error object. */
function rejectionError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  let text: string;
  try {
    text = typeof reason === "string" ? reason : (JSON.stringify(reason) ?? String(reason));
  } catch {
    text = String(reason);
  }
  const error = new Error(
    "This error originated either by throwing inside of an async function without a catch block, " +
      `or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${text}".`,
  );
  error.name = "UnhandledPromiseRejection";
  (error as Error & { code: string }).code = "ERR_UNHANDLED_REJECTION";
  return error;
}

export function installUnhandledHandlers(getClient: () => JekimoClient | undefined, timeoutMs: number): () => void {
  const reported = new WeakSet<object>();
  let crashing = false;

  const report = (error: unknown, mechanism: string): void => {
    if (isObject(error)) {
      if (reported.has(error)) return;
      reported.add(error);
    }
    getClient()?.captureException(error, { severity: "fatal", attributes: { mechanism, handled: false } });
  };

  /** Waits for delivery with a ref'd timer, so the process stays up until it is done. */
  const deliverThen = (next: () => void): void => {
    const client = getClient();
    if (!client) {
      next();
      return;
    }
    const timer = setTimeout(next, timeoutMs);
    void client.flush(timeoutMs).then(() => {
      clearTimeout(timer);
      next();
    });
  };

  const onUncaught = (error: unknown, origin?: string): void => {
    report(error, origin === "unhandledRejection" ? "unhandledRejection" : "uncaughtException");
    const others = process.listeners("uncaughtException").filter((l) => l !== onUncaught);
    if (others.length > 0) {
      // The application handles uncaught exceptions itself; just send.
      void getClient()?.flush(timeoutMs);
      return;
    }
    if (crashing) return;
    crashing = true;
    let rethrown = false;
    deliverThen(() => {
      if (rethrown) return;
      rethrown = true;
      uninstall();
      // Thrown from a fresh tick with no listener left, so Node prints it
      // and exits with its usual code.
      setImmediate(() => {
        throw error;
      });
    });
  };

  const onRejection = (reason: unknown): void => {
    const error = rejectionError(reason);
    report(isObject(reason) ? reason : error, "unhandledRejection");
    if (isObject(reason) && reason !== error) reported.add(error);
    const others = process.listeners("unhandledRejection").filter((l) => l !== onRejection);
    if (others.length > 0) return;
    switch (unhandledRejectionsMode()) {
      case "throw":
        // Node would raise it as an uncaught exception; do the same.
        process.nextTick(() => {
          throw error;
        });
        break;
      case "warn-with-error-code":
        process.emitWarning(error);
        process.exitCode = 1;
        break;
      default:
        // `warn` warns regardless of listeners, `strict` already raised it,
        // and `none` is silent.
        break;
    }
  };

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);

  function uninstall(): void {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
  }
  return uninstall;
}
