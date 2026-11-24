import { randomUUID } from "node:crypto";
import { parseIngestionKey } from "@jekimo/event-schema";
import type { CronMonitorClient, CronMonitorOptions } from "./types/cron.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createCronMonitor(options: CronMonitorOptions): CronMonitorClient {
  let enabled = true;
  let endpoint = "";
  let closed = false;
  let failed = false;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let kick: ReturnType<typeof setTimeout> | undefined;
  const queue: string[] = [];
  const report = (message: string) => {
    try {
      options.onError?.(message);
    } catch {}
  };
  const transport =
    options.transport ??
    (async (url, init) => {
      const response = await fetch(url, init as RequestInit);
      await response.body?.cancel();
      return { status: response.status, headers: response.headers, text: async () => "" };
    });
  const limit =
    typeof options.maxQueueSize === "number" && Number.isFinite(options.maxQueueSize)
      ? Math.max(2, Math.min(1000, Math.floor(options.maxQueueSize)))
      : 100;
  try {
    const url = new URL(options.baseUrl);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !UUID.test(options.monitorId) ||
      !parseIngestionKey(options.ingestionKey)
    )
      throw new Error();
    endpoint = `${url.origin}${url.pathname.replace(/\/+$/, "")}/api/v1/cron/${options.monitorId}/check-ins`;
  } catch {
    enabled = false;
    report("Invalid cron monitor configuration; monitoring disabled.");
  }
  async function pump(): Promise<void> {
    while (queue.length && !closed) {
      const body = queue[0];
      if (body === undefined) break;
      let sent = false;
      for (let attempt = 0; attempt < 3 && !closed; attempt++) {
        controller = new AbortController();
        const timer = setTimeout(() => controller?.abort(), 5000);
        timer.unref();
        try {
          const response = await transport(endpoint, {
            method: "POST",
            headers: { authorization: `Bearer ${options.ingestionKey}`, "content-type": "application/json" },
            body,
            signal: controller.signal,
            redirect: "manual",
          });
          if (response.status >= 200 && response.status < 300) {
            sent = true;
            break;
          }
          if (response.status !== 429 && response.status < 500) break;
        } catch {
        } finally {
          clearTimeout(timer);
          controller = undefined;
        }
        if (attempt < 2 && !closed)
          await new Promise<void>((resolve) => {
            const retry = setTimeout(resolve, 250 * 2 ** attempt);
            retry.unref();
          });
      }
      queue.shift();
      if (!sent) {
        failed = true;
        report("Cron check-in could not be delivered.");
      }
    }
  }
  const client: CronMonitorClient = {
    get enabled() {
      return enabled && !closed;
    },
    checkIn(status, runId = randomUUID()) {
      if (!enabled || closed) return undefined;
      if (!UUID.test(runId) || !["started", "ok", "error"].includes(status)) {
        report("Invalid cron check-in.");
        return undefined;
      }
      if (queue.length >= limit) {
        failed = true;
        report("Cron check-in queue is full; check-in dropped.");
        return undefined;
      }
      queue.push(JSON.stringify({ run_id: runId, status }));
      if (!running && !kick) {
        kick = setTimeout(() => {
          kick = undefined;
          running = pump().finally(() => {
            running = undefined;
          });
        }, 0);
        kick.unref();
      }
      return runId;
    },
    async withMonitor(job) {
      const runId = client.checkIn("started");
      try {
        const result = await job();
        if (runId) client.checkIn("ok", runId);
        return result;
      } catch (error) {
        if (runId) client.checkIn("error", runId);
        throw error;
      }
    },
    async flush(timeoutMs = 2000) {
      if (!enabled || closed) return queue.length === 0 && !failed;
      if (kick) {
        clearTimeout(kick);
        kick = undefined;
      }
      running ??= pump().finally(() => {
        running = undefined;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          running.then(() => queue.length === 0 && !failed),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(
              () => resolve(false),
              Math.max(0, Math.min(Number.isFinite(timeoutMs) ? timeoutMs : 2000, 60000)),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close(timeoutMs) {
      const drained = await client.flush(timeoutMs);
      closed = true;
      controller?.abort();
      if (kick) clearTimeout(kick);
      queue.length = 0;
      return drained;
    },
  };
  return client;
}
