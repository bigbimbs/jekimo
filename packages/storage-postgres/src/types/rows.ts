import type { UserRecord } from "../types.js";

export interface UserRow {
  id: string;
  email: string;
  instance_role: UserRecord["instanceRole"];
  status: UserRecord["status"];
  created_at: Date;
}
