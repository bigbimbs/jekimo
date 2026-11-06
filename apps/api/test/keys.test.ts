import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INGESTION_KEY_PATTERN, parseIngestionKey } from "@jekimo/event-schema";
import { generateIngestionKey, hashesEqual, hashIngestionKey, keyIdForLookup, UNKNOWN_KEY_ID, verifyIngestionKey } from "../src/keys.js";
import { argon2Hasher, passwordProblem } from "../src/passwords.js";
import { hashSessionToken, newSessionToken } from "../src/session.js";

describe("ingestion key generation", () => {
  it("produces jk_<key_id>_<secret> keys that the protocol parser accepts", () => {
    for (let i = 0; i < 200; i++) {
      const k = generateIngestionKey();
      expect(k.key).toMatch(INGESTION_KEY_PATTERN);
      expect(parseIngestionKey(k.key)?.keyId).toBe(k.keyId);
      expect(k.keyId).toHaveLength(12);
      expect(k.keyId).not.toMatch(/[ILOU]/);
    }
  });

  it("does not repeat keys or key ids", () => {
    const keys = Array.from({ length: 1000 }, () => generateIngestionKey());
    expect(new Set(keys.map((k) => k.key)).size).toBe(1000);
    expect(new Set(keys.map((k) => k.keyId)).size).toBe(1000);
  });

  it("stores SHA-256 of the whole key string", () => {
    const k = generateIngestionKey();
    const expected = createHash("sha256").update(k.key).digest();
    expect(Buffer.from(k.keyHash).equals(expected)).toBe(true);
    expect(Buffer.from(hashIngestionKey(k.key)).equals(expected)).toBe(true);
  });
});

describe("ingestion key verification", () => {
  it("accepts the right key and rejects any other", () => {
    const k = generateIngestionKey();
    const other = generateIngestionKey();
    expect(verifyIngestionKey(k.key, { keyHash: k.keyHash })).toBe(true);
    expect(verifyIngestionKey(other.key, { keyHash: k.keyHash })).toBe(false);
    // Same key_id, different secret.
    expect(verifyIngestionKey(`jk_${k.keyId}_${"a".repeat(32)}`, { keyHash: k.keyHash })).toBe(false);
    expect(verifyIngestionKey(k.key, null)).toBe(false);
    expect(verifyIngestionKey(null, null)).toBe(false);
  });

  it("routes malformed tokens through a lookup like unknown ones", () => {
    expect(keyIdForLookup("not-a-key")).toEqual({ keyId: UNKNOWN_KEY_ID, wellFormed: false });
    expect(keyIdForLookup(null)).toEqual({ keyId: UNKNOWN_KEY_ID, wellFormed: false });
    const k = generateIngestionKey();
    expect(keyIdForLookup(k.key)).toEqual({ keyId: k.keyId, wellFormed: true });
    // The placeholder can never be a real key id.
    expect(UNKNOWN_KEY_ID).not.toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
  });

  it("compares hashes only when both are 32 bytes", () => {
    expect(hashesEqual(new Uint8Array(32), new Uint8Array(32))).toBe(true);
    expect(hashesEqual(new Uint8Array(31), new Uint8Array(31))).toBe(false);
  });
});

describe("passwords and session tokens", () => {
  it("hashes passwords with Argon2id", async () => {
    const hash = await argon2Hasher.hash("synthetic-password-1");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await argon2Hasher.verify(hash, "synthetic-password-1")).toBe(true);
    expect(await argon2Hasher.verify(hash, "synthetic-password-2")).toBe(false);
    expect(await argon2Hasher.verify("not-a-hash", "x")).toBe(false);
  });

  it("enforces 12 to 128 characters with no composition rules", () => {
    expect(passwordProblem("short")).toMatch(/at least 12/);
    expect(passwordProblem("a".repeat(129))).toMatch(/at most 128/);
    expect(passwordProblem("aaaaaaaaaaaa")).toBeNull();
  });

  it("uses 256-bit session tokens and stores only their hash", () => {
    const token = newSessionToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(hashSessionToken(token)).toHaveLength(32);
  });
});
