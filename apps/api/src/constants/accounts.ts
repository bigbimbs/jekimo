export const ACCOUNT_LINK_KINDS = ["invite", "reset-password"] as const;
export type AccountLinkKind = (typeof ACCOUNT_LINK_KINDS)[number];
