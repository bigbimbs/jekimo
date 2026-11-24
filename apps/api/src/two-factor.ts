import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BASE32, TWO_FACTOR } from "./constants/two-factor.js";

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) result += BASE32[(value << (5 - bits)) & 31];
  return result;
}

function decodeBase32(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret) {
    const digit = BASE32.indexOf(char);
    if (digit < 0) throw new Error("invalid authenticator secret");
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpAt(secret: string, step: number, digits: number = TWO_FACTOR.digits): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 10 ** digits).padStart(digits, "0");
}

export function verifyTotp(secret: string, code: string, now: Date): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now.getTime() / (TWO_FACTOR.periodSeconds * 1000));
  for (const step of [current, current - 1, current + 1]) {
    if (step >= 0 && timingSafeEqual(Buffer.from(code), Buffer.from(totpAt(secret, step)))) return step;
  }
  return null;
}

export function newAuthenticatorSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function authenticatorUri(secret: string, email: string): string {
  return `otpauth://totp/${encodeURIComponent(`${TWO_FACTOR.issuer}:${email}`)}?${new URLSearchParams({ secret, issuer: TWO_FACTOR.issuer, algorithm: "SHA1", digits: String(TWO_FACTOR.digits), period: String(TWO_FACTOR.periodSeconds) })}`;
}

export function encryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value)
    throw new Error("JEKIMO_MFA_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

export function encryptFactor(secret: string, key: string, userId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  cipher.setAAD(Buffer.from(userId));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptFactor(encrypted: string, key: string, userId: string): string {
  const [version, iv, tag, ciphertext, extra] = encrypted.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext || extra !== undefined)
    throw new Error("invalid encrypted authenticator");
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(key), Buffer.from(iv, "base64"));
  cipher.setAAD(Buffer.from(userId));
  cipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([cipher.update(Buffer.from(ciphertext, "base64")), cipher.final()]).toString("utf8");
}

export function recoveryHash(code: string, userId: string): string | null {
  const normalized = code.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) return null;
  return createHash("sha256").update(`${userId}:${normalized}`).digest("hex");
}

export function newRecoveryCodes(userId: string): { codes: string[]; hashes: string[] } {
  const codes = Array.from(
    { length: TWO_FACTOR.recoveryCount },
    () => randomBytes(16).toString("hex").match(/.{4}/g)?.join("-") ?? "",
  );
  return { codes, hashes: codes.map((code) => recoveryHash(code, userId) as string) };
}
