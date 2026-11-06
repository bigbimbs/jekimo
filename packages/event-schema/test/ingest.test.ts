import { describe, expect, it } from "vitest";
import {
  bearerToken,
  INGEST_ERROR_STATUS,
  LIMITS,
  parseIngestionKey,
  RETRYABLE_INGEST_ERROR_CODES,
  validateIngestRequest,
} from "../src/index.js";
import { clone, exceptionExample, loadExamples, type Mutable } from "./fixtures.js";

const now = new Date("2026-11-05T12:00:00Z");

function ingestEvents(): Mutable[] {
  return loadExamples().map(({ event }) => {
    const e = clone(event) as Mutable;
    delete e.project_id;
    return e;
  });
}

describe("ingestion keys", () => {
  const good = "jk_01JBQ4Z3H8X9_wq7m2k9f4t8v1x3z6b5n8c2d7g4h1j5r";

  it("parses a well-formed key", () => {
    expect(parseIngestionKey(good)).toEqual({ keyId: "01JBQ4Z3H8X9", secret: "wq7m2k9f4t8v1x3z6b5n8c2d7g4h1j5r" });
  });

  it("rejects malformed keys", () => {
    for (const bad of [
      "",
      "jk_",
      "sk_01JBQ4Z3H8X9_wq7m2k9f4t8v1x3z6b5n8c2d7g4h1j5r",
      "jk_01JBQ4Z3H8X_wq7m2k9f4t8v1x3z6b5n8c2d7g4h1j5r",
      "jk_01JBQ4Z3H8XI_wq7m2k9f4t8v1x3z6b5n8c2d7g4h1j5r",
      "jk_01JBQ4Z3H8X9_WQ7M2K9F4T8V1X3Z6B5N8C2D7G4H1J5R",
      "jk_01JBQ4Z3H8X9_wq7m2k9f4t8v1x3z6b5n8c2d7g4h1",
      `${good} `,
      42,
      null,
    ]) {
      expect(parseIngestionKey(bad), String(bad)).toBeNull();
    }
  });

  it("extracts bearer tokens case-insensitively", () => {
    expect(bearerToken(`Bearer ${good}`)).toBe(good);
    expect(bearerToken(`bearer   ${good}`)).toBe(good);
    expect(bearerToken(`Basic ${good}`)).toBeNull();
    expect(bearerToken(good)).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe("validateIngestRequest: request level", () => {
  it("rejects non-object bodies", () => {
    for (const body of [null, [], "x", 1, undefined]) {
      const r = validateIngestRequest(body, { now });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.error.code).toBe("invalid_request");
    }
  });

  it("rejects missing, non-array, and empty events", () => {
    for (const body of [{}, { events: {} }, { events: [] }, { events: "x" }]) {
      const r = validateIngestRequest(body, { now });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.error.code).toBe("invalid_request");
        expect(r.status).toBe(400);
      }
    }
  });

  it("rejects more than the batch limit", () => {
    const [e] = ingestEvents();
    const r = validateIngestRequest({ events: Array.from({ length: LIMITS.MAX_BATCH_EVENTS + 1 }, () => e) }, { now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.error.code).toBe("too_many_events");
  });

  it("accepts exactly the batch limit", () => {
    const [e] = ingestEvents();
    const r = validateIngestRequest({ events: Array.from({ length: LIMITS.MAX_BATCH_EVENTS }, () => e) }, { now });
    expect(r.ok).toBe(true);
  });

  it("rejects oversized bodies when the size is known", () => {
    const r = validateIngestRequest({ events: ingestEvents() }, { now, bodyBytes: LIMITS.MAX_BATCH_BYTES + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.error.code).toBe("payload_too_large");
      expect(r.status).toBe(413);
    }
  });

  it("ignores unknown top-level body fields", () => {
    const r = validateIngestRequest({ events: ingestEvents(), future: true }, { now });
    expect(r.ok).toBe(true);
  });
});

describe("validateIngestRequest: per-event results", () => {
  it("accepts a valid batch and builds the 202 body", () => {
    const events = ingestEvents();
    const r = validateIngestRequest({ events }, { now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.accepted.map((a) => a.index)).toEqual([0, 1, 2]);
      expect(r.rejected).toEqual([]);
      expect(r.duplicates).toEqual([]);
      expect(r.response).toEqual({ accepted: events.map((e) => e.event_id), rejected: [] });
      expect(r.response.warnings).toBeUndefined();
      expect(r.skewMs).toBeUndefined();
    }
  });

  it("accepts the valid events of a mixed batch and reports the rest by index", () => {
    const events = ingestEvents();
    const bad = clone(events[1]!);
    delete bad.message;
    const withProject = clone(events[2]!);
    withProject.project_id = "prj_other";
    const r = validateIngestRequest({ events: [events[0], bad, withProject, { nonsense: true }] }, { now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.accepted).toEqual([events[0]!.event_id]);
      expect(r.rejected.map((x) => x.index)).toEqual([1, 2, 3]);
      expect(r.rejected[0]).toMatchObject({ event_id: bad.event_id, errors: [{ path: "/message", code: "required" }] });
      expect(r.rejected[1]!.errors).toEqual([expect.objectContaining({ path: "/project_id", code: "forbidden" })]);
      expect(r.rejected[2]!.event_id).toBeUndefined();
    }
  });

  it("deduplicates repeated event_ids within a request", () => {
    const [e] = ingestEvents();
    const r = validateIngestRequest({ events: [e, clone(e), e] }, { now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.accepted).toHaveLength(1);
      expect(r.duplicates).toEqual([1, 2]);
      expect(r.response.accepted).toEqual([e!.event_id]);
      expect(r.rejected).toEqual([]);
    }
  });

  it("collects unknown-field warnings with the event index", () => {
    const events = ingestEvents();
    events[1]!.extra = 1;
    const r = validateIngestRequest({ events }, { now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.warnings).toEqual([
        expect.objectContaining({ index: 1, path: "/extra", code: "unknown_field" }),
      ]);
      expect("extra" in r.accepted[1]!.event).toBe(false);
    }
  });

  it("never carries project_id into accepted events", () => {
    const r = validateIngestRequest({ events: ingestEvents() }, { now });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.accepted.every((a) => a.event.project_id === undefined)).toBe(true);
  });
});

describe("validateIngestRequest: clock skew", () => {
  it("evaluates the future-timestamp rule against sent_at when present", () => {
    const e = clone(exceptionExample()) as Mutable;
    delete e.project_id;
    // Client clock is one hour ahead of the server.
    const clientNow = new Date(now.getTime() + 60 * 60 * 1000);
    e.timestamp = new Date(clientNow.getTime() - 1000).toISOString();

    const withoutSentAt = validateIngestRequest({ events: [e] }, { now });
    expect(withoutSentAt.ok && withoutSentAt.rejected[0]?.errors[0]?.code).toBe("future_timestamp");

    const withSentAt = validateIngestRequest({ sent_at: clientNow.toISOString(), events: [e] }, { now });
    expect(withSentAt.ok).toBe(true);
    if (withSentAt.ok) {
      expect(withSentAt.accepted).toHaveLength(1);
      expect(withSentAt.skewMs).toBe(60 * 60 * 1000);
    }
  });

  it("ignores an unparseable sent_at", () => {
    const r = validateIngestRequest({ sent_at: "yesterday", events: ingestEvents() }, { now });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skewMs).toBeUndefined();
  });
});

describe("protocol tables", () => {
  it("maps every error code to a status", () => {
    expect(Object.values(INGEST_ERROR_STATUS).every((s) => s >= 400 && s < 600)).toBe(true);
  });

  it("marks only 429 and 503 codes as retryable", () => {
    for (const [code, status] of Object.entries(INGEST_ERROR_STATUS)) {
      const retryable = RETRYABLE_INGEST_ERROR_CODES.has(code as keyof typeof INGEST_ERROR_STATUS);
      expect(retryable, code).toBe(status === 429 || status === 503);
    }
  });
});
