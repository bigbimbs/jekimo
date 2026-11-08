import { PROJECT_PERMISSIONS, type ProjectPermission } from "@jekimo/event-schema/constants";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../lib/api-context";
import { queryKeys } from "../../lib/query-keys";
import type { ProjectPermissions } from "../../types/projects";
import { useSession } from "../auth/session";

const ALL: ReadonlySet<ProjectPermission> = new Set(PROJECT_PERMISSIONS);
const NONE: ReadonlySet<ProjectPermission> = new Set();

/**
 * The signed-in user's permissions in a project, to decide which controls to
 * show. The server checks every request on its own; this only hides what
 * would be refused. Instance admins hold every permission
 * (docs/access-model.md, "Instance roles").
 */
export function useProjectPermissions(projectId: string): ProjectPermissions {
  const api = useApi();
  const { user } = useSession();
  const isAdmin = user.instance_role === "admin";
  const query = useQuery({
    queryKey: queryKeys.permissions(projectId, user.id),
    enabled: !isAdmin,
    staleTime: 60_000,
    queryFn: async () => {
      const [members, roles] = await Promise.all([api.listMembers(projectId), api.listRoles(projectId)]);
      const role = members.find((m) => m.user_id === user.id)?.role.toLowerCase();
      return new Set(roles.find((r) => r.name.toLowerCase() === role)?.permissions ?? []);
    },
  });
  if (isAdmin) return { permissions: ALL, isPending: false };
  return { permissions: query.data ?? NONE, isPending: query.isPending };
}
