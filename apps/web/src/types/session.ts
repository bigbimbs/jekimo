import type { User } from "./api";

export interface SessionState {
  user: User;
  signOut(): Promise<void>;
}
