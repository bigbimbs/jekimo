import type { MetadataRepository } from "@jekimo/storage-postgres";

export interface AccountToken {
  /** Returned once; never stored or logged. */
  token: string;
  tokenHash: Uint8Array;
}

export interface AdminCommandDeps {
  metadata: MetadataRepository;
  inviteExpiryDays: number;
  publicUrl: string | null;
  clock: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
}
