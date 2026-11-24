import { describe, expect, it } from "vitest";
import {
  decryptFactor,
  encodeBase32,
  encryptFactor,
  encryptionKey,
  newRecoveryCodes,
  recoveryHash,
  totpAt,
  verifyTotp,
} from "../src/two-factor.js";

const SECRET = encodeBase32(Buffer.from("12345678901234567890"));
const KEY = Buffer.alloc(32, 7).toString("base64");

describe("authenticator primitives", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("matches RFC 6238 SHA-1 vector at %s", (time, expected) => {
    expect(totpAt(SECRET, Math.floor(time / 30), 8)).toBe(expected);
  });
  it("accepts only six digits within the one-step clock window", () => {
    const now = new Date(1234567890 * 1000);
    const step = Math.floor(now.getTime() / 30_000);
    for (const offset of [-1, 0, 1]) expect(verifyTotp(SECRET, totpAt(SECRET, step + offset), now)).toBe(step + offset);
    expect(verifyTotp(SECRET, totpAt(SECRET, step - 2), now)).toBeNull();
    expect(verifyTotp(SECRET, "12345x", now)).toBeNull();
  });
  it("encrypts secrets with fresh IVs and binds ciphertext to its user", () => {
    const cipher = encryptFactor(SECRET, KEY, "user-1");
    expect(cipher).not.toContain(SECRET);
    expect(cipher).not.toBe(encryptFactor(SECRET, KEY, "user-1"));
    expect(decryptFactor(cipher, KEY, "user-1")).toBe(SECRET);
    expect(() => decryptFactor(cipher, KEY, "user-2")).toThrow();
    expect(() => decryptFactor(cipher, Buffer.alloc(32, 8).toString("base64"), "user-1")).toThrow();
    expect(() => encryptionKey("bad")).toThrow("JEKIMO_MFA_ENCRYPTION_KEY");
  });
  it("creates unique, user-bound, hashed high-entropy recovery codes", () => {
    const recovery = newRecoveryCodes("user-1");
    expect(recovery.codes).toHaveLength(8);
    expect(new Set(recovery.codes).size).toBe(8);
    for (const [index, code] of recovery.codes.entries()) {
      expect(code.replaceAll("-", "")).toMatch(/^[a-f0-9]{32}$/);
      expect(recoveryHash(code.toUpperCase(), "user-1")).toBe(recovery.hashes[index]);
      expect(recoveryHash(code, "user-2")).not.toBe(recovery.hashes[index]);
    }
    expect(recoveryHash("000000", "user-1")).toBeNull();
  });
});
