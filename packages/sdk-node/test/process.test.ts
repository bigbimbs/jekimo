/**
 * Process-level behaviour runs in child processes, because the test runner
 * installs its own uncaughtException handlers. The SDK is bundled from source
 * with esbuild so the children need no build step.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unhandledRejectionsMode } from "../src/node.js";
import { KEY } from "./helpers.js";

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "jekimo-sdk-process-"));
  await build({
    entryPoints: [join(import.meta.dirname, "../src/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(dir, "sdk.mjs"),
    logLevel: "silent",
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stderr: string;
  events: Array<Record<string, unknown>>;
  stdout: string;
  ms: number;
}

/**
 * Runs `body` after creating a client whose transport prints each request's
 * events to stdout as `EVENTS <json>`.
 */
function run(body: string, { transport = "accept", args = [] as string[], init = "" } = {}): Run {
  const transports: Record<string, string> = {
    accept: `async (url, req) => {
      const parsed = JSON.parse(typeof req.body === "string" ? req.body : (await import("node:zlib")).gunzipSync(req.body).toString());
      writeSync(1, "EVENTS " + JSON.stringify(parsed.events) + "\\n");
      return { status: 202, headers: { get: () => null }, text: async () => JSON.stringify({ accepted: parsed.events.map((e) => e.event_id), rejected: [] }) };
    }`,
    // Holds a ref'd handle like an open socket until aborted.
    hang: `(url, req) => new Promise((_r, reject) => {
      const socket = setInterval(() => {}, 1000);
      req.signal.addEventListener("abort", () => { clearInterval(socket); writeSync(1, "ABORTED\\n"); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
    })`,
  };
  const file = join(dir, `case-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    file,
    `import { writeSync } from "node:fs";
import * as jekimo from "./sdk.mjs";
const client = jekimo.init({
  baseUrl: "https://jekimo.example.com",
  ingestionKey: ${JSON.stringify(KEY)},
  transport: ${transports[transport]},
  onDrop: (d) => writeSync(1, "DROP " + JSON.stringify(d) + "\\n"),
  ${init}
});
${body}
`,
  );
  const started = Date.now();
  const result = spawnSync(process.execPath, [...args, file], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  const events = result.stdout
    .split("\n")
    .filter((l) => l.startsWith("EVENTS "))
    .flatMap((l) => JSON.parse(l.slice(7)) as Array<Record<string, unknown>>);
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, events, ms: Date.now() - started };
}

describe("captureUnhandled", () => {
  it("reports an uncaught exception, then crashes the way Node would", () => {
    const r = run(`jekimo.captureUnhandled();
setTimeout(() => { throw new Error("synthetic crash"); }, 0);`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Error: synthetic crash");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      kind: "exception",
      severity: "fatal",
      message: "synthetic crash",
      attributes: { mechanism: "uncaughtException", handled: false },
    });
  });

  it("reports an unhandled rejection once, then crashes under the default mode", () => {
    const r = run(`jekimo.captureUnhandled();
Promise.reject(new TypeError("synthetic rejection"));`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("TypeError: synthetic rejection");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ severity: "fatal", attributes: { mechanism: "unhandledRejection" } });
  });

  it("wraps a non-error rejection reason like Node does", () => {
    const r = run(`jekimo.captureUnhandled();
Promise.reject("plain reason");`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("plain reason");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ exception: { type: "UnhandledPromiseRejection" } });
  });

  it("leaves the application's own handlers in charge", () => {
    const r = run(`jekimo.captureUnhandled();
process.on("uncaughtException", (e) => writeSync(1, "APP " + e.message + "\\n"));
process.on("unhandledRejection", (e) => writeSync(1, "APP " + e.message + "\\n"));
setTimeout(() => { throw new Error("handled crash"); }, 0);
Promise.reject(new Error("handled rejection"));
setTimeout(() => writeSync(1, "STILL RUNNING\\n"), 50);`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("APP handled crash");
    expect(r.stdout).toContain("APP handled rejection");
    expect(r.stdout).toContain("STILL RUNNING");
    expect(r.events.map((e) => e.message).sort()).toEqual(["handled crash", "handled rejection"]);
  });

  it("keeps --unhandled-rejections=warn behaviour", () => {
    const r = run(
      `jekimo.captureUnhandled();
Promise.reject(new Error("warned"));`,
      { args: ["--unhandled-rejections=warn"] },
    );
    expect(r.status).toBe(0);
    expect(r.events).toHaveLength(1);
  });

  it("crashes within the timeout when delivery hangs", () => {
    const r = run(
      `jekimo.captureUnhandled({ timeoutMs: 300 });
setTimeout(() => { throw new Error("slow crash"); }, 0);`,
      { transport: "hang" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("slow crash");
    expect(r.ms).toBeLessThan(5000);
  });

  it("reads the rejection mode from flags and NODE_OPTIONS", () => {
    expect(unhandledRejectionsMode([], undefined)).toBe("throw");
    expect(unhandledRejectionsMode(["--unhandled-rejections=strict"], undefined)).toBe("strict");
    expect(unhandledRejectionsMode(["--unhandled-rejections", "none"], undefined)).toBe("none");
    expect(unhandledRejectionsMode([], "--max-old-space-size=512 --unhandled-rejections=warn")).toBe("warn");
    expect(unhandledRejectionsMode(["--unhandled-rejections=bogus"], undefined)).toBe("throw");
  });
});

describe("process exit", () => {
  it("flushes queued events when the process exits naturally", () => {
    const r = run(`jekimo.log("info", "goodbye");`);
    expect(r.status).toBe(0);
    expect(r.events.map((e) => e.message)).toEqual(["goodbye"]);
  });

  it("does not hold the process open past the shutdown timeout", () => {
    const r = run(`jekimo.log("info", "stuck");`, { transport: "hang", init: "shutdownTimeoutMs: 200," });
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(5000);
    expect(r.stdout).toContain("ABORTED");
    expect(r.stdout).toContain('DROP {"reason":"shutdown","count":1}');
  });

  it("does not keep an idle process alive", () => {
    const r = run(`setTimeout(() => writeSync(1, "DONE\\n"), 10);`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DONE");
    expect(r.ms).toBeLessThan(5000);
  });
});
