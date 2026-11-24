import type { Member } from "./api";

export type MemberDialogAction = { kind: "add" } | { kind: "edit" | "remove"; member: Member };

export type MemberChange =
  | { kind: "add"; email: string; role: string }
  | { kind: "edit"; userId: string; role: string }
  | { kind: "remove"; userId: string };
