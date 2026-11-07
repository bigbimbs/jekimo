import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, type JekimoClient } from "../../../packages/sdk-node/src/index.js";
import { processIngestJob } from "../../worker/src/process.js";
import { type Harness, harness, projectWithKey, type SignedIn, signIn } from "./helpers.js";

const PROJECT = "prj_sdk";

let h: Harness;
let alice: SignedIn;
let client: JekimoClient;

beforeAll(async () => {
  h = await harness();
  // The SDK stamps events with the real clock.
  h.now.value = new Date();
  alice = await signIn(h, "alice@example.test");
  const { key } = await projectWithKey(h, alice, PROJECT);
  const access = await h.metadata.resolveProjectAccess({ userId: alice.userId, instanceRole: "member" }, PROJECT);
  await h.metadata.setRedactionRules(access!, { keys: ["tenant_id"], patterns: [] });
  await h.app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = h.app.server.address() as AddressInfo;
  client = init({
    baseUrl: `http://127.0.0.1:${port}`,
    ingestionKey: key,
    service: "billing",
    environment: "test",
    flushOnExit: false,
    onError: () => {},
  });
});

afterAll(async () => {
  await client.close(1000);
  await h.app.close();
});

describe("SDK to local API", () => {
  it("delivers redacted events that the worker stores and the API reads back", async () => {
    const error = new Error("synthetic charge failure");
    const id = client.captureException(error, {
      context: { route: "/charge", authorization: "Bearer not-a-real-token" },
      attributes: { tenant_id: "t_1", card: { cvv: "000", last4: "4242" } },
    });
    expect(id).toBeDefined();
    expect(await client.flush(5000)).toBe(true);
    expect(client.stats()).toMatchObject({ sent: 1, rejected: 0, dropped: 0 });

    const job = await h.queue.dequeue(10);
    expect(job).toHaveLength(1);
    await processIngestJob(job[0]!.payload, { metadata: h.metadata, events: h.events }, { jobId: job[0]!.id });

    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${PROJECT}/events/${id}`,
      headers: alice.headers,
    });
    expect(res.statusCode).toBe(200);
    const { event } = res.json() as { event: Record<string, unknown> };
    expect(event).toMatchObject({
      project_id: PROJECT,
      kind: "exception",
      service: "billing",
      environment: "test",
      sdk: { name: "@jekimo/sdk-node" },
      exception: { type: "Error", value: "synthetic charge failure" },
      // authorization is redacted by the SDK; tenant_id only by the worker's project rule.
      context: { route: "/charge", authorization: "[REDACTED]" },
      attributes: { tenant_id: "[REDACTED]", card: { cvv: "[REDACTED]", last4: "4242" } },
    });
    expect(event.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
