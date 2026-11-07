import type { ProjectAccess } from "@jekimo/storage-postgres";
import { HOUR_MS } from "../../constants/index.js";
import { ApiError } from "../../errors.js";
import { generateIngestionKey } from "../../keys.js";
import type { KeyServiceDeps } from "../../types/index.js";

const keyNotFound = () => new ApiError(404, "key_not_found", "no ingestion key with that key_id in this project");

/** The full key in each `secret` is returned once and never stored or logged. */
export class KeyService {
  constructor(private readonly deps: KeyServiceDeps) {}

  async create(access: ProjectAccess, name: string, sourceIp: string) {
    const generated = generateIngestionKey();
    const record = await this.deps.metadata.createIngestionKey(access, {
      keyId: generated.keyId,
      keyHash: generated.keyHash,
      name,
      sourceIp,
    });
    return { record, secret: generated.key };
  }

  /** `now` is the instant the key statuses are reported for. */
  async list(access: ProjectAccess) {
    const now = this.deps.clock();
    return { keys: await this.deps.metadata.listIngestionKeys(access), now };
  }

  /** The old key keeps working for `graceHours`. */
  async rotate(access: ProjectAccess, keyId: string, graceHours: number, sourceIp: string) {
    const now = this.deps.clock();
    const generated = generateIngestionKey();
    const result = await this.deps.metadata.rotateIngestionKey(access, {
      keyId,
      newKeyId: generated.keyId,
      newKeyHash: generated.keyHash,
      oldExpiresAt: new Date(now.getTime() + graceHours * HOUR_MS),
      now,
      sourceIp,
    });
    if (!result.ok) {
      if (result.reason === "not_active")
        throw new ApiError(409, "key_not_active", "only an active key can be rotated; this one is revoked or rotating");
      throw keyNotFound();
    }
    return { created: result.created, old: result.old, secret: generated.key, now };
  }

  async revoke(access: ProjectAccess, keyId: string, sourceIp: string) {
    const now = this.deps.clock();
    const result = await this.deps.metadata.revokeIngestionKey(access, { keyId, now, sourceIp });
    if (!result.ok) {
      if (result.reason === "already_revoked")
        throw new ApiError(409, "key_already_revoked", "this key is already revoked");
      throw keyNotFound();
    }
    return { key: result.key, now };
  }
}
