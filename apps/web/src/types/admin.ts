import type { AccountUser } from "./api";

export type UserAction = { kind: "role" | "deactivate" | "reactivate" | "reset"; user: AccountUser };

export interface IssuedAccountLink {
  kind: "invite" | "reset";
  email: string;
  link: string;
  expiresAt: string;
}
