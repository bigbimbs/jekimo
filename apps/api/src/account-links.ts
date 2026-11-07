/**
 * Single-use invitation and password reset links (docs/access-model.md,
 * "Invitations and recovery without email"). The token is 256 random bits,
 * returned once to the instance admin who asked for it, and stored only as
 * SHA-256. It travels in the URL fragment, which browsers do not send to
 * servers, so it stays out of proxy and access logs.
 */

import { createHash, randomBytes } from "node:crypto";

export type AccountLinkKind = "invite" | "reset-password";

export interface AccountToken {
  /** Returned once; never stored or logged. */
  token: string;
  tokenHash: Uint8Array;
}

export function newAccountToken(): AccountToken {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashAccountToken(token) };
}

export function hashAccountToken(token: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(token, "utf8").digest());
}

/** `<public url>/<kind>#token=<token>`, or a path when no public URL is configured. */
export function accountLink(publicUrl: string | null, kind: AccountLinkKind, token: string): string {
  return `${publicUrl ?? ""}/${kind}#token=${token}`;
}

/** A token as presented in a request body: base64url, 43 characters. */
export function readAccountToken(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
