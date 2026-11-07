// docs/access-model.md, "Invitations and recovery without email". The token
// travels in the URL fragment, which browsers do not send to servers, so it
// stays out of proxy and access logs. Only its SHA-256 is stored.

import { createHash, randomBytes } from "node:crypto";
import type { AccountLinkKind } from "./constants/index.js";
import type { AccountToken } from "./types/index.js";

export function newAccountToken(): AccountToken {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashAccountToken(token) };
}

export function hashAccountToken(token: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(token, "utf8").digest());
}

export function accountLink(publicUrl: string | null, kind: AccountLinkKind, token: string): string {
  return `${publicUrl ?? ""}/${kind}#token=${token}`;
}

export function readAccountToken(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
