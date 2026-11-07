export const INGESTION_KEY_STATUSES = ["active", "rotating", "expired", "revoked"] as const;
export type IngestionKeyStatus = (typeof INGESTION_KEY_STATUSES)[number];

export const ACCOUNT_TOKEN_PURPOSES = ["invitation", "password_reset"] as const;
export type AccountTokenPurpose = (typeof ACCOUNT_TOKEN_PURPOSES)[number];
