import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function notificationKey(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(value))
    throw new Error("JEKIMO_NOTIFICATIONS_ENCRYPTION_KEY must be 64 hexadecimal characters");
  return Buffer.from(value, "hex");
}

export function sealNotification(value: unknown, key: string, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", notificationKey(key), nonce);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}

export function openNotification<T>(value: string, key: string, context: string): T {
  const [nonce, tag, data] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!nonce || !tag || !data) throw new Error("invalid encrypted notification settings");
  const decipher = createDecipheriv("aes-256-gcm", notificationKey(key), nonce);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")) as T;
}
