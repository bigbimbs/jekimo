import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), createTransport: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.createTransport } }));

import { sendEmail, sendWebhook } from "../src/notification-transport.js";

beforeEach(() => {
  vi.clearAllMocks();
});
it("pins the validated IP, signs exact bytes and preserves the TLS hostname", async () => {
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  let body = "";
  mocks.request.mockImplementation((_options, callback) => {
    const req = new EventEmitter();
    return Object.assign(req, {
      end: (value: string) => {
        body = value;
        callback({ statusCode: 204, destroy: vi.fn() });
      },
    });
  });
  const secret = "s".repeat(32);
  await sendWebhook(
    "webhook",
    { destination: "https://example.test/hook", signingSecret: secret },
    { subject: "Test", text: "Synthetic" },
    "delivery-id",
  );
  const options = mocks.request.mock.calls[0]![0];
  expect(options).toMatchObject({
    hostname: "8.8.8.8",
    servername: "example.test",
    path: "/hook",
    port: 443,
    agent: false,
  });
  expect(options.headers["x-jekimo-signature"]).toBe(
    `sha256=${createHmac("sha256", secret).update(`${options.headers["x-jekimo-timestamp"]}.${body}`).digest("hex")}`,
  );
  expect(JSON.parse(body).id).toBe("delivery-id");
});
it("rejects mixed private/public DNS answers without opening a connection", async () => {
  mocks.lookup.mockResolvedValue([
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  await expect(
    sendWebhook(
      "webhook",
      { destination: "https://example.test/hook", signingSecret: "s".repeat(32) },
      { subject: "Test", text: "Synthetic" },
      "id",
    ),
  ).rejects.toMatchObject({ code: "destination_blocked", permanent: true });
  expect(mocks.request).not.toHaveBeenCalled();
});
it.each([
  [302, true],
  [403, true],
  [429, false],
  [503, false],
])("handles HTTP %s without following redirects", async (status, permanent) => {
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.request.mockImplementation((_options, callback) =>
    Object.assign(new EventEmitter(), { end: () => callback({ statusCode: status, destroy: vi.fn() }) }),
  );
  await expect(
    sendWebhook(
      "slack",
      { destination: "https://hooks.slack.com/services/demo" },
      { subject: "Test", text: "Synthetic" },
      "id",
    ),
  ).rejects.toMatchObject({ code: `http_${status}`, permanent });
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
it("requires encrypted SMTP, uses a stable message id and conceals provider errors", async () => {
  const sendMail = vi.fn().mockRejectedValue({ responseCode: 535, message: "password=synthetic-secret" });
  const close = vi.fn();
  mocks.createTransport.mockReturnValue({ sendMail, close });
  await expect(
    sendEmail(
      {
        host: "smtp.example.test",
        port: 587,
        security: "starttls",
        username: "user",
        password: "synthetic-secret",
        from: "alerts@example.test",
        fromName: "Jekimo",
        enabled: true,
      },
      "ops@example.test",
      { subject: "Test", text: "Synthetic" },
      "delivery-id",
    ),
  ).rejects.toMatchObject({ message: "smtp_535", permanent: true });
  expect(mocks.createTransport).toHaveBeenCalledWith(
    expect.objectContaining({
      requireTLS: true,
      secure: false,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    }),
  );
  expect(sendMail).toHaveBeenCalledWith(
    expect.objectContaining({ messageId: "<delivery-id@jekimo.local>", to: { name: "", address: "ops@example.test" } }),
  );
  expect(close).toHaveBeenCalled();
});
