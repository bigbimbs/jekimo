/**
 * The event query API against the in-memory event store: filters, cursor
 * pagination, and single-event lookup scoped to the project in the URL
 * (docs/access-model.md, "Authorization enforcement", rule 4).
 */

import type { EventStoreCapabilities } from "@jekimo/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";
import { type Harness, harness, projectWithKey, type SignedIn, signIn, storeEvent } from "./helpers.js";

const A = "prj_events_a";
const B = "prj_events_b";
const ID = (n: number) => `01JBQ4Z3H8X9T2K7M5N6P8R${String(n).padStart(3, "0")}`;

let h: Harness;
let alice: SignedIn;
let bob: SignedIn;
let key: string;

async function list(user: SignedIn, project: string, query = "") {
  const res = await h.app.inject({
    method: "GET",
    url: `/api/v1/projects/${project}/events${query}`,
    headers: user.headers,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { events: { event: { event_id: string } }[]; next_cursor?: string };
  return { ids: body.events.map((e) => e.event.event_id), next: body.next_cursor };
}

beforeAll(async () => {
  h = await harness();
  alice = await signIn(h, "alice@example.test");
  bob = await signIn(h, "bob@example.test");
  ({ key } = await projectWithKey(h, alice, A));
  await projectWithKey(h, bob, B);
  const t = (s: number) => new Date(h.now.value.getTime() - s * 1000);
  await storeEvent(
    h,
    A,
    {
      event_id: ID(1),
      kind: "exception",
      severity: "error",
      message: "Database request failed while charging invoice",
      environment: "production",
      release: "billing@1.4.2",
      fingerprint: "fp-db",
    },
    t(50),
  );
  await storeEvent(
    h,
    A,
    {
      event_id: ID(2),
      kind: "log",
      severity: "info",
      message: "Invoice charged",
      environment: "staging",
      release: "billing@1.4.2",
      fingerprint: "fp-charged",
    },
    t(40),
  );
  await storeEvent(
    h,
    A,
    {
      event_id: ID(3),
      kind: "event",
      severity: "info",
      message: "connect to db.internal timed out",
      environment: "production",
      release: "billing@1.5.0",
      fingerprint: "fp-db",
    },
    t(30),
  );
  await storeEvent(
    h,
    A,
    {
      event_id: ID(4),
      kind: "log",
      severity: "warning",
      message: "Retrying charge-invoice job",
      fingerprint: "fp-retry",
    },
    t(20),
  );
  await storeEvent(
    h,
    B,
    { event_id: ID(9), kind: "exception", severity: "fatal", message: "Bob's secret failure", fingerprint: "fp-db" },
    t(10),
  );
});

describe("event filters", () => {
  it.each([
    ["", [4, 3, 2, 1]],
    ["?kind=exception", [1]],
    ["?kind=log,event", [4, 3, 2]],
    ["?severity=info", [3, 2]],
    ["?environment=production", [3, 1]],
    ["?release=billing%401.4.2", [2, 1]],
    ["?fingerprint=fp-db", [3, 1]],
    ["?q=invoice", [4, 2, 1]],
    ["?q=INVOICE%20database", [1]],
    ["?q=internal", [3]],
    ["?q=charge", [4]],
    ["?q=secret", []],
    ["?environment=production&kind=event&q=db", [3]],
  ])("%s", async (query, expected) => {
    expect((await list(alice, A, query)).ids).toEqual(expected.map(ID));
  });

  it("refuses text search when the event store does not offer it", async () => {
    const capabilities = h.events.capabilities as EventStoreCapabilities;
    capabilities.textSearch = false;
    try {
      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/projects/${A}/events?q=invoice`,
        headers: alice.headers,
      });
      expect(res.statusCode).toBe(400);
      expect(await list(alice, A, "?kind=exception")).toMatchObject({ ids: [ID(1)] });
    } finally {
      capabilities.textSearch = true;
    }
  });
});

describe("cursor pagination", () => {
  it("walks every page newest first, then stops", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list(alice, A, `?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.ids);
      cursor = page.next;
      pages++;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(4);
    expect(seen).toEqual([4, 3, 2, 1].map(ID));
  });

  it("keeps filters across pages", async () => {
    const first = await list(alice, A, "?fingerprint=fp-db&limit=1");
    expect(first.ids).toEqual([ID(3)]);
    const second = await list(alice, A, `?fingerprint=fp-db&limit=1&cursor=${first.next}`);
    expect(second).toEqual({ ids: [ID(1)], next: undefined });
  });
});

describe("GET /api/v1/projects/:id/events/:event_id", () => {
  const get = (user: SignedIn | null, project: string, eventId: string) =>
    h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${project}/events/${eventId}`,
      ...(user && { headers: user.headers }),
    });

  it("returns one stored event with its server metadata", async () => {
    const res = await get(alice, A, ID(1));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      key_id: "0123456789AB",
      received_at: new Date(h.now.value.getTime() - 50_000).toISOString(),
      event: { event_id: ID(1), project_id: A, kind: "exception", fingerprint: "fp-db" },
    });
  });

  it("answers 404 for an unknown or malformed event_id", async () => {
    for (const id of [ID(7), "not-a-ulid"]) {
      const res = await get(alice, A, id);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
  });

  it("does not return another project's event by guessing its event_id", async () => {
    // Through the project Alice belongs to: scoped in the query, so not found.
    const viaOwn = await get(alice, A, ID(9));
    expect(viaOwn.statusCode).toBe(404);
    expect(viaOwn.body).not.toContain("secret");
    // Through Bob's project: Alice is not a member, so the project is hidden.
    const viaOther = await get(alice, B, ID(9));
    expect(viaOther.statusCode).toBe(404);
    expect(viaOther.json().error.message).toBe("project not found");
    // Bob can read it.
    expect((await get(bob, B, ID(9))).statusCode).toBe(200);
  });

  it("requires a session and rejects ingestion keys", async () => {
    expect((await get(null, A, ID(1))).statusCode).toBe(401);
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${A}/events/${ID(1)}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
