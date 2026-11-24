import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, harness, projectWithKey, type SignedIn, signIn, storeEvent } from "./helpers.js";

let h: Harness;
let owner: SignedIn;
let outsider: SignedIn;
let key: string;
beforeAll(async () => {
  h = await harness();
  owner = await signIn(h, "db-owner@example.test");
  outsider = await signIn(h, "db-other@example.test");
  ({ key } = await projectWithKey(h, owner));
  await storeEvent(
    h,
    "prj_test",
    {
      kind: "event",
      database: { name: "invoices.list", system: "postgresql", operation: "select", duration_ms: 300, status: "error" },
    },
    new Date(h.now.value.getTime() - 1000),
  );
});
afterAll(async () => h.app.close());
it("enforces session and project permission on database summaries", async () => {
  const url = "/api/v1/projects/prj_test/database/summary";
  expect((await h.app.inject({ url })).statusCode).toBe(401);
  expect((await h.app.inject({ url, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
  expect((await h.app.inject({ url, headers: outsider.headers })).statusCode).toBe(404);
  const res = await h.app.inject({ url, headers: owner.headers });
  expect(res.statusCode).toBe(200);
  expect(res.json().totals).toMatchObject({ count: 1, errors: 1, slow: 1 });
  expect(res.json().recent).toHaveLength(1);
});
it("bounds windows and thresholds and separates records", async () => {
  for (const query of ["slow_ms=NaN", "slow_ms=-1", "slow_ms=", "from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z"])
    expect(
      (await h.app.inject({ url: `/api/v1/projects/prj_test/database/summary?${query}`, headers: owner.headers }))
        .statusCode,
    ).toBe(400);
  expect(
    (await h.app.inject({ url: "/api/v1/projects/prj_test/events?database=false", headers: owner.headers })).json()
      .events,
  ).toHaveLength(0);
  expect(
    (await h.app.inject({ url: "/api/v1/projects/prj_test/events?database=true", headers: owner.headers })).json()
      .events,
  ).toHaveLength(1);
  expect(
    (await h.app.inject({ url: "/api/v1/projects/prj_test/events?database=invalid", headers: owner.headers }))
      .statusCode,
  ).toBe(400);
});
