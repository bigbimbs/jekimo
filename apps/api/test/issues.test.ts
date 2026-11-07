import type { IssueSummary } from "@jekimo/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";
import { type Harness, harness, projectWithKey, type SignedIn, setRole, signIn, storeEvent } from "./helpers.js";

const A = "prj_issues_a";
const B = "prj_issues_b";
const EVENT_ID = "01JBQ4Z3H8X9T2K7M5N6P8R9SV";

let h: Harness;
let alice: SignedIn;
let bob: SignedIn;
let viewer: SignedIn;

interface PublicIssue {
  id: string;
  fingerprint: string;
  status: string;
  environments: string[];
  last_event_id?: string;
}

function summary(fingerprint: string, overrides: Partial<IssueSummary> = {}): IssueSummary {
  const at = h.now.value;
  return {
    fingerprint,
    title: `synthetic ${fingerprint}`,
    kind: "exception",
    lastSeverity: "error",
    eventCount: 1,
    firstSeen: at,
    lastSeen: at,
    ...overrides,
  };
}

async function list(user: SignedIn, project: string, query = "") {
  const res = await h.app.inject({
    method: "GET",
    url: `/api/v1/projects/${project}/issues${query}`,
    headers: user.headers,
  });
  return { status: res.statusCode, body: res.json() as { issues: PublicIssue[]; next_cursor?: string } };
}

function idOf(fingerprint: string): string {
  return h.metadata.issues.find((i) => i.fingerprint === fingerprint)!.id;
}

async function act(user: SignedIn, project: string, issueId: string, action: string) {
  return h.app.inject({
    method: "POST",
    url: `/api/v1/projects/${project}/issues/${issueId}/${action}`,
    headers: user.headers,
    payload: {},
  });
}

beforeAll(async () => {
  h = await harness();
  alice = await signIn(h, "alice@example.test");
  bob = await signIn(h, "bob@example.test");
  viewer = await signIn(h, "viewer@example.test");
  await projectWithKey(h, alice, A);
  await projectWithKey(h, bob, B);
  setRole(h, A, viewer.userId, "viewer");
  const t = (s: number) => new Date(h.now.value.getTime() - s * 1000);
  await storeEvent(h, A, { event_id: EVENT_ID, fingerprint: "fp-db", kind: "exception", severity: "error" }, t(10));
  await h.metadata.upsertIssues(A, [
    summary("fp-db", { lastSeen: t(10), firstSeen: t(3600), lastEventId: EVENT_ID, environments: ["production"] }),
    summary("fp-log", {
      kind: "log",
      lastSeverity: "warning",
      lastSeen: t(20),
      firstSeen: t(20),
      environments: ["staging"],
    }),
    summary("fp-old", { lastSeen: t(7200), firstSeen: t(7200) }),
  ]);
  await h.metadata.upsertIssues(B, [summary("fp-db")]);
});

describe("GET /api/v1/projects/:id/issues", () => {
  it("lists the project's issues, newest last_seen first", async () => {
    const { status, body } = await list(alice, A);
    expect(status).toBe(200);
    expect(body.issues.map((i) => i.fingerprint)).toEqual(["fp-db", "fp-log", "fp-old"]);
    expect(body.issues[0]).toMatchObject({
      status: "unresolved",
      kind: "exception",
      last_severity: "error",
      event_count: 1,
      environments: ["production"],
      last_event_id: EVENT_ID,
    });
    expect(body.next_cursor).toBeUndefined();
  });

  it("filters by status, kind, severity, environment, and time", async () => {
    const fps = async (q: string) => (await list(alice, A, q)).body.issues.map((i) => i.fingerprint);
    expect(await fps("?kind=log")).toEqual(["fp-log"]);
    expect(await fps("?severity=error")).toEqual(["fp-db", "fp-old"]);
    expect(await fps("?environment=staging")).toEqual(["fp-log"]);
    expect(await fps("?status=resolved,ignored")).toEqual([]);
    const hourAgo = new Date(h.now.value.getTime() - 3600_000).toISOString();
    expect(await fps(`?from=${hourAgo}`)).toEqual(["fp-db", "fp-log"]);
    expect(await fps(`?to=${hourAgo}`)).toEqual(["fp-old"]);
  });

  it("pages with a cursor", async () => {
    const first = await list(alice, A, "?limit=2");
    expect(first.body.issues.map((i) => i.fingerprint)).toEqual(["fp-db", "fp-log"]);
    const second = await list(alice, A, `?limit=2&cursor=${first.body.next_cursor}`);
    expect(second.body.issues.map((i) => i.fingerprint)).toEqual(["fp-old"]);
    expect(second.body.next_cursor).toBeUndefined();
  });

  it("rejects invalid parameters", async () => {
    for (const q of ["?status=open", "?kind=crash", "?limit=0", "?limit=201", "?from=yesterday", "?cursor=nope"]) {
      const { status, body } = await list(alice, A, q);
      expect({ q, status }).toEqual({ q, status: 400 });
      expect((body as unknown as { error: { code: string } }).error.code).toBe("invalid_request");
    }
  });

  it("never shows another project's issues", async () => {
    expect((await list(bob, B)).body.issues).toHaveLength(1);
    expect((await list(bob, A)).status).toBe(404);
  });
});

describe("GET /api/v1/projects/:id/issues/:issue_id", () => {
  it("returns the issue with its latest event", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${A}/issues/${idOf("fp-db")}`,
      headers: viewer.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.issue).toMatchObject({ fingerprint: "fp-db", title: "synthetic fp-db" });
    expect(body.latest_event.event).toMatchObject({ event_id: EVENT_ID, project_id: A });
  });

  it("returns a null latest event when the issue has none recorded", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/projects/${A}/issues/${idOf("fp-old")}`,
      headers: alice.headers,
    });
    expect(res.json().latest_event).toBeNull();
  });

  it("answers 404 for an unknown id or another project's issue", async () => {
    const bobsIssue = h.metadata.issues.find((i) => i.projectId === B)!.id;
    for (const id of [bobsIssue, "00000000-0000-4000-8000-000000000000", "not-an-id"]) {
      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/projects/${A}/issues/${id}`,
        headers: alice.headers,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
  });
});

describe("status changes", () => {
  it("resolves, ignores, and reopens, and audit-logs each change", async () => {
    const id = idOf("fp-log");
    const before = h.metadata.audit.length;
    const resolved = await act(alice, A, id, "resolve");
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().issue).toMatchObject({
      id,
      status: "resolved",
      status_changed_at: h.now.value.toISOString(),
    });
    expect((await act(alice, A, id, "ignore")).json().issue.status).toBe("ignored");
    expect((await act(alice, A, id, "reopen")).json().issue.status).toBe("unresolved");
    expect(h.metadata.audit.slice(before)).toEqual([
      expect.objectContaining({
        action: "issue.resolved",
        actorUserId: alice.userId,
        targetType: "issue",
        targetId: id,
        projectId: A,
        details: { from: "unresolved", to: "resolved" },
      }),
      expect.objectContaining({ action: "issue.ignored", details: { from: "resolved", to: "ignored" } }),
      expect.objectContaining({ action: "issue.reopened", details: { from: "ignored", to: "unresolved" } }),
    ]);
  });

  it("does not log a change that changes nothing", async () => {
    const id = idOf("fp-old");
    await act(alice, A, id, "resolve");
    const before = h.metadata.audit.length;
    const again = await act(alice, A, id, "resolve");
    expect(again.statusCode).toBe(200);
    expect(again.json().issue.status).toBe("resolved");
    expect(h.metadata.audit.length).toBe(before);
  });

  it("needs issues.manage", async () => {
    const res = await act(viewer, A, idOf("fp-db"), "resolve");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("answers 404 for another project's issue and for non-members", async () => {
    const bobsIssue = h.metadata.issues.find((i) => i.projectId === B)!.id;
    expect((await act(alice, A, bobsIssue, "resolve")).statusCode).toBe(404);
    expect((await act(alice, B, bobsIssue, "resolve")).statusCode).toBe(404);
    expect(h.metadata.issues.find((i) => i.id === bobsIssue)!.status).toBe("unresolved");
  });

  it("requires the CSRF header", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${A}/issues/${idOf("fp-db")}/resolve`,
      headers: { cookie: alice.cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf_failed");
  });
});
