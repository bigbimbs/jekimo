import type { UserRecord } from "./access.js";

export interface UserRow {
  id: string;
  email: string;
  instance_role: UserRecord["instanceRole"];
  status: UserRecord["status"];
  created_at: Date;
}

export interface ProjectRow {
  id: string;
  name: string;
  retention_days: number;
  sample_rate: number;
  disabled: boolean;
  created_at: Date;
}
