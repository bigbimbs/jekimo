import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createCronMonitor } from "../src/cron.js";
import type { Transport } from "../src/types/transport.js";

const options = () => ({
  baseUrl: "https://jekimo.example.test",
  ingestionKey: "jk_0123456789AB_abcdefghijklmnopqrstuvwxyz012345",
  monitorId: randomUUID(),
});
const response = (status = 200) => ({ status, headers: { get: () => null }, text: async () => "{}" });
it("wraps successful jobs without waiting for delivery and pairs check-ins", async () => {
  const transport = vi.fn<Transport>().mockResolvedValue(response());
  const opts = options();
  const client = createCronMonitor({ ...opts, transport });
  expect(await client.withMonitor(() => 42)).toBe(42);
  expect(transport).not.toHaveBeenCalled();
  expect(await client.flush()).toBe(true);
  const requests = transport.mock.calls.map((c) => JSON.parse(c[1].body as string));
  expect(requests.map((r) => r.status)).toEqual(["started", "ok"]);
  expect(requests[0].run_id).toBe(requests[1].run_id);
  expect(transport.mock.calls[0]?.[0]).toBe(`${opts.baseUrl}/api/v1/cron/${opts.monitorId}/check-ins`);
  expect(transport.mock.calls[0]?.[1]).toMatchObject({
    redirect: "manual",
    headers: { authorization: `Bearer ${opts.ingestionKey}` },
  });
  await client.close();
});
it("preserves application errors and reports a failed run", async () => {
  const transport = vi.fn<Transport>().mockResolvedValue(response());
  const client = createCronMonitor({ ...options(), transport });
  const failure = new Error("synthetic app error");
  await expect(
    client.withMonitor(() => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  await client.flush();
  expect(JSON.parse(transport.mock.calls[1]![1].body as string).status).toBe("error");
  await client.close();
});
it("bounds the queue and keeps secrets out of transport error messages", async () => {
  const onError = vi.fn();
  const transport = vi.fn<Transport>().mockResolvedValue(response(403));
  const client = createCronMonitor({ ...options(), transport, maxQueueSize: 2, onError });
  client.checkIn("ok");
  client.checkIn("ok");
  expect(client.checkIn("ok")).toBeUndefined();
  expect(await client.flush()).toBe(false);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(onError.mock.calls)).not.toContain("jk_");
  await client.close();
});
it("rejects unsafe configuration while still running the application job", async () => {
  const transport = vi.fn<Transport>();
  const client = createCronMonitor({ ...options(), baseUrl: "http://external.example.test", transport });
  expect(client.enabled).toBe(false);
  expect(await client.withMonitor(() => "done")).toBe("done");
  expect(transport).not.toHaveBeenCalled();
});
it("does not enqueue check-ins after close", async () => {
  const client = createCronMonitor({ ...options(), transport: vi.fn<Transport>().mockResolvedValue(response()) });
  await client.close();
  expect(client.enabled).toBe(false);
  expect(client.checkIn("started")).toBeUndefined();
});
