/**
 * Ingestion keys: `jk_<key_id>_<secret>` (docs/ingestion-protocol.md, "Key
 * format"). The server stores key_id in plain text and SHA-256 of the whole
 * key string, and compares hashes in constant time.
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { parseIngestionKey } from "@jekimo/event-schema";

/** Crockford base32 without I, L, O, U. */
const KEY_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SECRET_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const KEY_ID_LENGTH = 12;
const SECRET_LENGTH = 32;

function randomString(alphabet: string, length: number): string {
  let out = "";
  // randomInt is uniform, so there is no modulo bias.
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export interface GeneratedKey {
  keyId: string;
  /** The full key. Returned to the user once and never stored or logged. */
  key: string;
  keyHash: Uint8Array;
}

export function hashIngestionKey(key: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(key, "utf8").digest());
}

export function generateIngestionKey(): GeneratedKey {
  const keyId = randomString(KEY_ID_ALPHABET, KEY_ID_LENGTH);
  const key = `jk_${keyId}_${randomString(SECRET_ALPHABET, SECRET_LENGTH)}`;
  return { keyId, key, keyHash: hashIngestionKey(key) };
}

/** Constant-time comparison of two 32-byte hashes. False on any length mismatch. */
export function hashesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) return false;
  return timingSafeEqual(a, b);
}

/** Lookup id used when the presented token is malformed, so timing matches an unknown key. */
export const UNKNOWN_KEY_ID = "------------";
const NO_MATCH = new Uint8Array(32);

export interface KeyRecordForCheck {
  keyHash: Uint8Array;
}

/**
 * Parses the presented token and returns the key_id to look up. A malformed
 * token still produces a lookup and a hash comparison, so malformed and
 * unknown keys take the same path.
 */
export function keyIdForLookup(token: string | null): { keyId: string; wellFormed: boolean } {
  const parsed = parseIngestionKey(token);
  return parsed ? { keyId: parsed.keyId, wellFormed: true } : { keyId: UNKNOWN_KEY_ID, wellFormed: false };
}

/** True when `token` hashes to the stored hash. Always performs one hash and one comparison. */
export function verifyIngestionKey(token: string | null, record: KeyRecordForCheck | null): boolean {
  const presented = hashIngestionKey(token ?? "");
  return hashesEqual(presented, record?.keyHash ?? NO_MATCH) && record !== null;
}
