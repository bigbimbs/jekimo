import { TIMESTAMP_PATTERN } from "@jekimo/event-schema";
import { ApiError } from "./errors.js";

/** The JSON body as an object; any other body reads as empty. */
export function bodyOf(request: { body: unknown }): Record<string, unknown> {
  return (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
}

export function parseTime(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, "invalid_request", `${name} must be an RFC 3339 timestamp`);
  }
  return new Date(value);
}

/** A comma-separated list of allowed values, or undefined when absent. */
export function parseList<T extends string>(value: unknown, name: string, allowed: readonly T[]): T[] | undefined {
  if (value === undefined) return undefined;
  const list = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0 || list.some((s) => !(allowed as readonly string[]).includes(s))) {
    throw new ApiError(400, "invalid_request", `${name} must be a comma-separated list of ${allowed.join(", ")}`);
  }
  return list as T[];
}

/** One exact-match value no longer than the envelope allows for that field. */
export function parseExact(value: unknown, name: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > maxChars) {
    throw new ApiError(400, "invalid_request", `${name} must be 1 to ${maxChars} characters`);
  }
  return value;
}

export function parseLimit(value: unknown, fallback: number, max: number): number {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new ApiError(400, "invalid_request", `limit must be a whole number from 1 to ${max}`);
  }
  return limit;
}

export function parseCursor(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

/** A trimmed name of 1 to `maxChars` characters; anything else is a 400 naming `field`. */
export function parseName(value: unknown, field: string, maxChars: number): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > maxChars)
    throw new ApiError(400, "invalid_request", `${field} must be 1 to ${maxChars} characters`);
  return name;
}
