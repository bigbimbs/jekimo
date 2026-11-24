import type { ClaimedNotification, NotificationRepository } from "@jekimo/storage-postgres";
import { sealNotification } from "@jekimo/storage-postgres";
import { describe, expect, it, vi } from "vitest";
import { DeliveryError, publicAddress, webhookBody } from "../src/notification-transport.js";
import { deliverNextNotification } from "../src/notifications.js";

describe("notification delivery", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "0.0.0.0",
    "224.0.0.1",
  ])("blocks private or reserved destination %s", (ip) => expect(publicAddress(ip)).toBe(false));
  it("allows public addresses", () => {
    expect(publicAddress("8.8.8.8")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("uses plain text Slack blocks to avoid interpreting issue content as mentions", () => {
    expect(
      JSON.parse(webhookBody("slack", { subject: "New issue", text: "<!channel> synthetic" }, "id")).blocks[0].text
        .type,
    ).toBe("plain_text");
  });
  it("delivers decrypted configuration only to the transport and persists safe failure codes", async () => {
    const key = "a".repeat(64);
    const job: ClaimedNotification = {
      id: "id",
      lease: "lease",
      attempts: 1,
      kind: "webhook",
      secret: `channel:${sealNotification({ destination: "https://example.test/secret" }, key, "channel")}`,
      payload: { subject: "New issue", text: "Synthetic" },
    };
    const repo = { claim: vi.fn().mockResolvedValue(job), finish: vi.fn() } as unknown as NotificationRepository;
    const send = vi.fn().mockRejectedValue(new Error("https://example.test/secret"));
    await deliverNextNotification(repo, key, null, send);
    expect(send).toHaveBeenCalled();
    expect(repo.finish).toHaveBeenCalledWith(job, "delivery_failed", false);
    send.mockRejectedValueOnce(new DeliveryError("http_403", true));
    await deliverNextNotification(repo, key, null, send);
    expect(repo.finish).toHaveBeenLastCalledWith(job, "http_403", true);
  });
  it("does not send when credentials cannot be decrypted", async () => {
    const job: ClaimedNotification = {
      id: "id",
      lease: "lease",
      attempts: 1,
      kind: "email",
      secret: "email-test:bad",
      payload: { subject: "Test", text: "Test" },
    };
    const repo = { claim: vi.fn().mockResolvedValue(job), finish: vi.fn() } as unknown as NotificationRepository;
    const send = vi.fn();
    await deliverNextNotification(repo, "a".repeat(64), null, send);
    expect(send).not.toHaveBeenCalled();
    expect(repo.finish).toHaveBeenCalledWith(job, "settings_unavailable", false);
  });
});
