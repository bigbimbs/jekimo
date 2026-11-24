import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, harness, projectWithKey, type SignedIn, signIn, storeEvent } from "./helpers.js";

let h: Harness, owner: SignedIn, outsider: SignedIn;
const trace = "a".repeat(32);
beforeAll(async () => {
  h = await harness();
  owner = await signIn(h, "trace-owner@example.test");
  outsider = await signIn(h, "trace-other@example.test");
  await projectWithKey(h, owner);
  await projectWithKey(h, outsider, "other");
  await storeEvent(h, "prj_test", { context: { trace_id: trace } }, new Date(h.now.value.getTime() - 1000));
  await storeEvent(h, "other", { context: { trace_id: trace } }, new Date(h.now.value.getTime() - 1000));
});
afterAll(async () => h.app.close());
it("filters trace records by authorized project with strict identifiers", async () => {
  const url = `/api/v1/projects/prj_test/events?trace_id=${trace}`;
  const res = await h.app.inject({ url, headers: owner.headers });
  expect(res.statusCode).toBe(200);
  expect(res.json().events).toHaveLength(1);
  expect(res.json().events[0].event.project_id).toBe("prj_test");
  expect((await h.app.inject({ url, headers: outsider.headers })).statusCode).toBe(404);
  expect((await h.app.inject({ url })).statusCode).toBe(401);
  for (const id of ["bad", "0".repeat(32), "A".repeat(32)])
    expect(
      (await h.app.inject({ url: `/api/v1/projects/prj_test/events?trace_id=${id}`, headers: owner.headers }))
        .statusCode,
    ).toBe(400);
  expect(
    (
      await h.app.inject({ url: `/api/v1/projects/prj_test/events?trace_id=${"b".repeat(32)}`, headers: owner.headers })
    ).json().events,
  ).toHaveLength(0);
});
