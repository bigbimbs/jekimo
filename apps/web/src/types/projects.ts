import type { ProjectPermission } from "@jekimo/event-schema/constants";
import type { Project } from "./api";

export interface ProjectOutlet {
  project: Project;
}

export interface ProjectPermissions {
  permissions: ReadonlySet<ProjectPermission>;
  isPending: boolean;
}
