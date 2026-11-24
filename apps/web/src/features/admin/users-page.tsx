import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { EmptyState, ErrorState, PageLoader } from "../../components/states";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Input, NativeSelect } from "../../components/ui/input";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useApi } from "../../lib/api-context";
import { useFormat } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import type { IssuedAccountLink, UserAction } from "../../types/admin";
import type { AccountUser, SessionResponse } from "../../types/api";
import { useSession } from "../auth/session";
import { AccountLinkDialog } from "./account-link-dialog";
import { AdminShell } from "./admin-shell";
import { UserActionDialog } from "./user-action-dialog";

export function UsersPage() {
  const { t } = useTranslation("admin");
  return (
    <AdminShell title={t("users")} description={t("usersIntro")}>
      <Users />
    </AdminShell>
  );
}

function Users() {
  const { t } = useTranslation("admin");
  const api = useApi();
  const format = useFormat();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user } = useSession();
  const users = useQuery({ queryKey: queryKeys.users, queryFn: api.listUsers });
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [action, setAction] = useState<UserAction | null>(null);
  const [issued, setIssued] = useState<IssuedAccountLink | null>(null);
  const [saved, setSaved] = useState(false);
  const rows =
    users.data?.filter(
      (row) =>
        row.email.toLowerCase().includes(search.trim().toLowerCase()) &&
        (!role || row.instance_role === role) &&
        (!status || row.status === status),
    ) ?? [];
  const admins = users.data?.filter((row) => row.instance_role === "admin" && row.status === "active").length ?? 0;
  async function changed(updated: AccountUser) {
    if (updated.id === user.id && (updated.instance_role !== user.instance_role || updated.status === "deactivated")) {
      const session = queryClient.getQueryData<SessionResponse>(queryKeys.session);
      await queryClient.cancelQueries();
      queryClient.clear();
      if (updated.status === "active" && session)
        queryClient.setQueryData(queryKeys.session, { ...session, user: updated });
      navigate(updated.status === "deactivated" ? "/sign-in" : "/", { replace: true });
      return;
    }
    queryClient.setQueryData<AccountUser[]>(queryKeys.users, (current) =>
      current?.map((row) => (row.id === updated.id ? updated : row)),
    );
    setSaved(true);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.users }),
      queryClient.invalidateQueries({ queryKey: ["admin", "audit"] }),
      queryClient.invalidateQueries({ queryKey: ["project"] }),
    ]);
  }
  function open(next: UserAction) {
    setSaved(false);
    setAction(next);
  }
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor="users-search" className="grid min-w-48 flex-1 gap-1.5 text-xs text-muted-foreground">
          {t("search")}
          <Input id="users-search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label htmlFor="users-role" className="grid gap-1.5 text-xs text-muted-foreground">
          {t("role")}
          <NativeSelect id="users-role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">{t("allRoles")}</option>
            <option value="admin">{t("roles.admin")}</option>
            <option value="member">{t("roles.member")}</option>
          </NativeSelect>
        </label>
        <label htmlFor="users-status" className="grid gap-1.5 text-xs text-muted-foreground">
          {t("status")}
          <NativeSelect id="users-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t("allStatuses")}</option>
            <option value="active">{t("statuses.active")}</option>
            <option value="deactivated">{t("statuses.deactivated")}</option>
          </NativeSelect>
        </label>
        <Button variant="outline" disabled={users.isFetching} onClick={() => void users.refetch()}>
          {t("refresh")}
        </Button>
        <Button asChild>
          <Link to="/admin/invitations?invite=1">{t("invite")}</Link>
        </Button>
      </div>
      {saved && (
        <p role="status" className="text-sm text-success">
          {t("saved")}
        </p>
      )}
      {users.error && users.data && (
        <Alert variant="destructive">
          <ErrorState error={users.error} onRetry={() => users.refetch()} />
        </Alert>
      )}
      <Card>
        {users.isPending ? (
          <PageLoader />
        ) : !users.data ? (
          <ErrorState error={users.error} onRetry={() => users.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("noneUsers")} />
        ) : (
          <Table>
            <caption className="sr-only">{t("users")}</caption>
            <TableHeader>
              <TableRow>
                {(["email", "role", "status", "created", "actions"] as const).map((key) => (
                  <TableHead key={key} className={key === "created" ? "hidden lg:table-cell" : undefined}>
                    {t(key)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <tbody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <span className="font-medium">{row.email}</span>
                    {row.id === user.id && <span className="ms-2 text-xs text-muted-foreground">{t("you")}</span>}
                  </TableCell>
                  <TableCell>{t(`roles.${row.instance_role}`)}</TableCell>
                  <TableCell>
                    <Badge>{t(`statuses.${row.status}`)}</Badge>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground lg:table-cell">
                    {format.dateTime(row.created_at)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" aria-label={t("actionsFor", { email: row.email })}>
                          <EllipsisIcon aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => open({ kind: "role", user: row })}>
                          {t("editRole")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            open({ kind: row.status === "active" ? "deactivate" : "reactivate", user: row })
                          }
                        >
                          {t(row.status === "active" ? "deactivate" : "reactivate")}
                        </DropdownMenuItem>
                        {row.status === "active" && (
                          <DropdownMenuItem onSelect={() => open({ kind: "reset", user: row })}>
                            {t("reset")}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {action && (
        <UserActionDialog
          key={`${action.user.id}/${action.kind}`}
          action={action}
          lastAdmin={admins <= 1 && action.user.status === "active" && action.user.instance_role === "admin"}
          onClose={() => setAction(null)}
          onChanged={changed}
          onIssued={(link) => {
            setIssued(link);
            void queryClient.invalidateQueries({ queryKey: ["admin", "audit"] });
          }}
        />
      )}
      {issued && <AccountLinkDialog issued={issued} onClose={() => setIssued(null)} />}
    </>
  );
}
