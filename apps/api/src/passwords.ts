/**
 * Password hashing with Argon2id (docs/access-model.md, "Passwords").
 * Parameters are above the OWASP minimum of m=19 MiB, t=2, p=1.
 */

import argon2 from "argon2";

export const PASSWORD_MIN_CHARS = 12;
export const PASSWORD_MAX_CHARS = 128;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export const argon2Hasher: PasswordHasher = {
  hash: (password) => argon2.hash(password, ARGON2_OPTIONS),
  async verify(hash, password) {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  },
};

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "password is required";
  if (password.length < PASSWORD_MIN_CHARS) return `password must be at least ${PASSWORD_MIN_CHARS} characters`;
  if (password.length > PASSWORD_MAX_CHARS) return `password must be at most ${PASSWORD_MAX_CHARS} characters`;
  return null;
}

/**
 * Verifies against a throwaway hash so that a sign-in for an unknown email
 * costs the same as one for a known email.
 */
export class TimingSafeVerifier {
  private dummy: Promise<string> | undefined;

  constructor(private readonly hasher: PasswordHasher) {}

  async verify(hash: string | null, password: string): Promise<boolean> {
    if (hash !== null) return this.hasher.verify(hash, password);
    this.dummy ??= this.hasher.hash("jekimo-timing-placeholder");
    await this.hasher.verify(await this.dummy, password);
    return false;
  }
}
