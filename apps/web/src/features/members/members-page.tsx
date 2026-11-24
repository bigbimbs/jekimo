import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, UsersIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState, ErrorState, PageHeader, PageLoader } from "../../components/states";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useApi } from "../../lib/api-context";
import { useFormat } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import type { Project } from "../../types/api";
import type { MemberChange, MemberDialogAction } from "../../types/members";
import { useSession } from "../auth/session";
import { useProjectPermissions } from "../projects/permissions";
import { useProject } from "../projects/use-project";
import { MemberDialog } from "./member-dialog";

export function MembersPage() {
  const { t } = useTranslation("members");
  const project = useProject();
  return (
    <div className="mx-auto grid max-w-5xl gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader title={t("title")} description={t("intro", { project: project.name })} />
      <MembersSection key={project.id} projectId={project.id} />
    </div>
  );
}

export function MembersSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation("members");
  const api = useApi();
  const queryClient = useQueryClient();
  const format = useFormat();
  const { user } = useSession();
  const { permissions, isPending: permissionsPending } = useProjectPermissions(projectId);
  const canManage = permissions.has("members.manage");
  const [action, setAction] = useState<MemberDialogAction | null>(null);
  const members = useQuery({ queryKey: queryKeys.members(projectId), queryFn: () => api.listMembers(projectId) });
  const roles = useQuery({ queryKey: queryKeys.roles(projectId), queryFn: () => api.listRoles(projectId) });
  const assignable = (roles.data ?? []).filter((role) => role.permissions.every((p) => permissions.has(p)));

  const change = useMutation({
    mutationFn: async (input: MemberChange) => {
      if (input.kind === "add") await api.addMember(projectId, input.email, input.role);
      else if (input.kind === "edit") await api.changeMemberRole(projectId, input.userId, input.role);
      else await api.removeMember(projectId, input.userId);
    },
    onSuccess: async (_, input) => {
      setAction(null);
      // A self-removal must drop cached access before a refetch can fail or finish.
      if (input.kind === "remove" && input.userId === user.id && user.instance_role !== "admin") {
        await queryClient.cancelQueries({ queryKey: queryKeys.projects });
        await queryClient.cancelQueries({ queryKey: queryKeys.project(projectId) });
        queryClient.setQueryData<Project[]>(queryKeys.projects, (projects) =>
          projects?.filter((p) => p.id !== projectId),
        );
        queryClient.removeQueries({ queryKey: queryKeys.project(projectId) });
      } else {
        if (input.kind === "edit" && input.userId === user.id && user.instance_role !== "admin") {
          await queryClient.cancelQueries({ queryKey: queryKeys.permissions(projectId, user.id) });
          queryClient.setQueryData(
            queryKeys.permissions(projectId, user.id),
            new Set(roles.data?.find((r) => r.name === input.role)?.permissions ?? []),
          );
        }
        await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });

  function open(next: MemberDialogAction) {
    change.reset();
    setAction(next);
  }

  let body: ReactNode;
  if (members.isError || roles.isError)
    body = (
      <ErrorState
        error={members.error ?? roles.error}
        onRetry={() => {
          void members.refetch();
          void roles.refetch();
        }}
      />
    );
  else if (members.isPending || roles.isPending || permissionsPending) body = <PageLoader />;
  else if (members.data.length === 0) body = <EmptyState icon={<UsersIcon />} title={t("empty")} />;
  else
    body = (
      <Table>
        <caption className="sr-only">{t("listTitle")}</caption>
        <TableHeader>
          <TableRow>
            <TableHead>{t("email")}</TableHead>
            <TableHead>{t("role")}</TableHead>
            <TableHead>{t("status")}</TableHead>
            <TableHead>{t("joined")}</TableHead>
            <TableHead>
              <span className="sr-only">{t("actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <tbody>
          {members.data.map((member) => (
            <TableRow key={member.user_id}>
              <TableCell className="font-medium">
                {member.email}
                {member.user_id === user.id && <span className="ms-2 text-xs text-muted-foreground">{t("you")}</span>}
              </TableCell>
              <TableCell>{member.role}</TableCell>
              <TableCell>
                {member.status === "active" || member.status === "deactivated"
                  ? t(`accountStatus.${member.status}`)
                  : member.status}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                <time dateTime={member.created_at}>{format.dateTime(member.created_at)}</time>
              </TableCell>
              <TableCell>
                {canManage && assignable.some((r) => r.name.toLowerCase() === member.role.toLowerCase()) && (
                  <fieldset className="flex justify-end gap-1" disabled={change.isPending}>
                    <legend className="sr-only">{t("rowActions", { email: member.email })}</legend>
                    <Button variant="ghost" size="xs" onClick={() => open({ kind: "edit", member })}>
                      {t("edit")}
                    </Button>
                    <Button variant="destructive-ghost" size="xs" onClick={() => open({ kind: "remove", member })}>
                      {t("remove")}
                    </Button>
                  </fieldset>
                )}
              </TableCell>
            </TableRow>
          ))}
        </tbody>
      </Table>
    );

  return (
    <Card aria-labelledby="members-title">
      <CardHeader
        title={t("listTitle")}
        titleId="members-title"
        {...(!canManage && !permissionsPending && { description: t("readOnly") })}
        actions={
          canManage &&
          !members.isError &&
          !roles.isError &&
          assignable.length > 0 && (
            <Button size="sm" disabled={change.isPending} onClick={() => open({ kind: "add" })}>
              <PlusIcon aria-hidden="true" />
              {t("add")}
            </Button>
          )
        }
      />
      {body}
      {action && canManage && (
        <MemberDialog
          action={action}
          roles={assignable}
          userId={user.id}
          pending={change.isPending}
          error={change.error}
          onClose={() => setAction(null)}
          onSubmit={(input) => change.mutate(input)}
        />
      )}
    </Card>
  );
}
