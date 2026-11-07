import { describe, expect, it } from "vitest";
import { createKeyRedactor, type EventEnvelope, REDACTED_VALUE, redactEvent } from "../src/index.js";
import { clone } from "./fixtures.js";

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    schema_version: 1,
    event_id: "01JBQ4Z3H8X9T2K7M5N6P8R9SV",
    timestamp: "2026-11-05T09:14:33.412Z",
    kind: "exception",
    severity: "error",
    message: "password reset failed for token abc",
    exception: { type: "Error", value: "token: not-a-real-token", stacktrace: "    at reset (/app/src/reset.ts:1:1)" },
    context: { route: "/reset", authorization: "Bearer not-a-real-token" },
    attributes: { user_id: "u_123", password: "not-a-real-password" },
    ...overrides,
  };
}

describe("redactEvent", () => {
  it("redacts every spelling of a default key", () => {
    const out = redactEvent(
      event({
        context: { "Set-Cookie": "a=1", set_cookie: "b=2", SETCOOKIE: "c=3", "api key": "k", route: "/x" },
      }),
    );
    expect(out.context).toEqual({
      "Set-Cookie": REDACTED_VALUE,
      set_cookie: REDACTED_VALUE,
      SETCOOKIE: REDACTED_VALUE,
      "api key": REDACTED_VALUE,
      route: "/x",
    });
  });

  it("redacts nested attributes down to depth 4 and inside arrays", () => {
    const out = redactEvent(
      event({
        attributes: {
          request: { auth: { client: { client_secret: "not-a-real-secret", id: "c1" } } },
          items: [{ sku: "A1", token: "not-a-real-token" }, "plain", [{ cvv: "000" }]],
        },
      }),
    );
    expect(out.attributes).toEqual({
      request: { auth: { client: { client_secret: REDACTED_VALUE, id: "c1" } } },
      items: [{ sku: "A1", token: REDACTED_VALUE }, "plain", [{ cvv: REDACTED_VALUE }]],
    });
  });

  it("replaces a redacted object whole", () => {
    const out = redactEvent(event({ attributes: { secret: { nested: "not-a-real-secret", n: 1 } } }));
    expect(out.attributes).toEqual({ secret: REDACTED_VALUE });
  });

  it("applies extra keys after normalization", () => {
    const out = redactEvent(event({ attributes: { "Customer-Email": "someone@example.test", plan: "pro" } }), {
      extraKeys: ["customer_email"],
    });
    expect(out.attributes).toEqual({ "Customer-Email": REDACTED_VALUE, plan: "pro" });
  });

  it("applies regular expression patterns to the original key", () => {
    const out = redactEvent(
      event({ context: { "x-internal-trace": "t", route: "/x" }, attributes: { "x-internal-id": 7, Plan: "pro" } }),
      { patterns: [/^x-internal-/g, /^plan$/] },
    );
    expect(out.context).toEqual({ "x-internal-trace": REDACTED_VALUE, route: "/x" });
    // Patterns see the key as sent, so the case-sensitive /^plan$/ leaves "Plan".
    expect(out.attributes).toEqual({ "x-internal-id": REDACTED_VALUE, Plan: "pro" });
  });

  it("drops context when asked", () => {
    const out = redactEvent(event(), { dropContext: true });
    expect(out).not.toHaveProperty("context");
    expect(out.attributes).toEqual({ user_id: "u_123", password: REDACTED_VALUE });
  });

  it("changes nothing outside context and attributes", () => {
    const input = event();
    const { context: _c, attributes: _a, ...rest } = redactEvent(input);
    const { context: _ic, attributes: _ia, ...inputRest } = input;
    expect(rest).toEqual(inputRest);
  });

  it("does not mutate the input", () => {
    const input = event({ attributes: { nested: { password: "not-a-real-password" }, list: [{ token: "t" }] } });
    const before = clone(input);
    const out = redactEvent(input, { extraKeys: ["route"], dropContext: false });
    expect(input).toEqual(before);
    expect(out).not.toBe(input);
    expect(out.attributes).not.toBe(input.attributes);
  });

  it("handles events without context or attributes", () => {
    const { context: _c, attributes: _a, ...bare } = event();
    expect(redactEvent(bare)).toEqual(bare);
    expect(() => redactEvent(bare, { dropContext: true, patterns: [/x/] })).not.toThrow();
  });
});

describe("createKeyRedactor", () => {
  it("combines the default list, extra keys, and patterns", () => {
    const redact = createKeyRedactor({ extraKeys: ["Tenant-Id"], patterns: [/^private_/] });
    expect(redact("Authorization")).toBe(true);
    expect(redact("tenant_id")).toBe(true);
    expect(redact("private_note")).toBe(true);
    expect(redact("route")).toBe(false);
  });
});
