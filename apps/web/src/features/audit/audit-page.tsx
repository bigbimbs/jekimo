import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState, ErrorState, PageLoader } from "../../components/states";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { AUDIT_PAGE_SIZE } from "../../constants/audit";
import { useApi } from "../../lib/api-context";
import { useErrorMessage } from "../../lib/errors";
import { useFormat } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import type { AuditEntry, AuditQuery } from "../../types/api";
import { AdminShell } from "../admin/admin-shell";
import { Field } from "../auth/auth-layout";

export function AuditPage() {
  const { t } = useTranslation("audit");
  return (
    <AdminShell title={t("title")} description={t("intro")} noAccess={t("noAccess")}>
      <AuditLog />
    </AdminShell>
  );
}

function AuditLog() {
  const { t } = useTranslation("audit");
  const labels = t("actionLabels", { returnObjects: true });
  const actionLabel = (value: string) => (Object.hasOwn(labels, value) ? labels[value as keyof typeof labels] : value);
  const targetLabels = t("targetLabels", { returnObjects: true });
  const api = useApi();
  const format = useFormat();
  const message = useErrorMessage();
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [filter, setFilter] = useState<AuditQuery>({ limit: AUDIT_PAGE_SIZE });
  const actions = useQuery({ queryKey: queryKeys.auditActions, queryFn: api.listAuditActions });
  const users = useQuery({ queryKey: queryKeys.users, queryFn: api.listUsers });
  const entries = useInfiniteQuery({
    queryKey: queryKeys.audit(filter),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listAudit({ ...filter, ...(pageParam && { cursor: pageParam }) }),
    getNextPageParam: (last) => last.next_cursor,
  });
  const rows = entries.data?.pages.flatMap((p) => p.entries) ?? [];
  const projects = useQuery({
    queryKey: queryKeys.projects,
    queryFn: api.listProjects,
    enabled: rows.some((entry) => entry.project_id || entry.target?.type === "project"),
  });
  const userNames = new Map(users.data?.map((user) => [user.id, user.email]));
  const projectNames = new Map(projects.data?.map((project) => [project.id, project.name]));
  function actorLabel(entry: AuditEntry) {
    return entry.actor ? (entry.actor.email ?? userNames.get(entry.actor.user_id) ?? t("unknownUser")) : t("system");
  }
  function targetLabel(entry: AuditEntry) {
    const target = entry.target;
    if (!target) return { type: t("noTarget"), name: undefined };
    const type = Object.hasOwn(targetLabels, target.type)
      ? targetLabels[target.type as keyof typeof targetLabels]
      : t("otherTarget");
    let name: string | undefined;
    if (target.type === "user") {
      const matchingActor = entry.actor?.user_id === target.id ? entry.actor : null;
      name = userNames.get(target.id ?? "") ?? matchingActor?.email ?? t("unknownUser");
    } else if (target.type === "project") {
      name = projectNames.get(target.id ?? "") ?? t("unknownProject");
    } else if (target.type === "invitation" && typeof entry.details.email === "string") {
      name = entry.details.email;
    } else if (target.type === "instance") {
      name = t("instanceTarget");
    }
    return { type, name };
  }
  function apply(e: FormEvent) {
    e.preventDefault();
    if (
      (from && Number.isNaN(Date.parse(from))) ||
      (to && Number.isNaN(Date.parse(to))) ||
      (from && to && Date.parse(from) >= Date.parse(to))
    ) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setFilter({
      limit: AUDIT_PAGE_SIZE,
      ...(action && { action }),
      ...(actor && { actor }),
      ...(from && { from: new Date(from).toISOString() }),
      ...(to && { to: new Date(to).toISOString() }),
    });
  }
  function clear() {
    setAction("");
    setActor("");
    setFrom("");
    setTo("");
    setInvalid(false);
    setFilter({ limit: AUDIT_PAGE_SIZE });
  }
  return (
    <>
      <Card>
        <form className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={apply}>
          <Field id="audit-action" label={t("action")}>
            <select
              id="audit-action"
              className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            >
              <option value="">{t("allActions")}</option>
              {actions.data?.map((a) => (
                <option key={a} value={a}>
                  {actionLabel(a)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="audit-actor" label={t("actor")}>
            <select
              id="audit-actor"
              className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
            >
              <option value="">{t("allActors")}</option>
              {users.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </select>
          </Field>
          <Field id="audit-from" label={t("from")}>
            <Input type="datetime-local" id="audit-from" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field id="audit-to" label={t("to")}>
            <Input type="datetime-local" id="audit-to" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">{t("timeHint")}</p>
          {invalid && (
            <Alert variant="destructive" className="sm:col-span-2 lg:col-span-4">
              {t("invalidRange")}
            </Alert>
          )}
          {(actions.error || users.error || projects.error) && (
            <div className="sm:col-span-2 lg:col-span-4">
              <ErrorState
                error={actions.error ?? users.error ?? projects.error}
                onRetry={() => {
                  void actions.refetch();
                  void users.refetch();
                  if (projects.error) void projects.refetch();
                }}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit">{t("apply")}</Button>
            <Button type="button" variant="outline" onClick={clear}>
              {t("clear")}
            </Button>
            <Button type="button" variant="ghost" disabled={entries.isFetching} onClick={() => void entries.refetch()}>
              {t("refresh")}
            </Button>
          </div>
        </form>
      </Card>
      <Card>
        {entries.isPending ? (
          <PageLoader />
        ) : !entries.data ? (
          <ErrorState error={entries.error} onRetry={() => entries.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("empty")} />
        ) : (
          <Table>
            <caption className="sr-only">{t("title")}</caption>
            <TableHeader>
              <TableRow>
                {(["time", "actor", "action", "target", "project", "sourceIp", "details"] as const).map((key) => (
                  <TableHead key={key}>{t(key)}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <tbody>
              {rows.map((entry) => {
                const target = targetLabel(entry);
                const identifiers = [
                  [t("actorId"), entry.actor?.user_id],
                  [t("targetType"), entry.target?.type],
                  [t("targetId"), entry.target?.id],
                  [t("projectId"), entry.project_id],
                ].filter((pair): pair is [string, string] => typeof pair[1] === "string");
                return (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap">
                      <time dateTime={entry.occurred_at}>{format.dateTime(entry.occurred_at)}</time>
                    </TableCell>
                    <TableCell>
                      {actorLabel(entry)}
                      {entry.via_instance_admin && (
                        <p className="text-xs text-muted-foreground">{t("instanceAdmin")}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-sm font-medium">{actionLabel(entry.action)}</TableCell>
                    <TableCell>
                      <span className="font-medium">{target.name ?? target.type}</span>
                      {target.name && <p className="text-xs text-muted-foreground">{target.type}</p>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {entry.project_id ? (projectNames.get(entry.project_id) ?? t("unknownProject")) : "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{entry.source_ip ?? "—"}</TableCell>
                    <TableCell>
                      {identifiers.length || Object.keys(entry.details).length ? (
                        <details>
                          <summary className="cursor-pointer text-primary">{t("details")}</summary>
                          <dl className="mt-2 grid gap-2 text-xs">
                            {identifiers.map(([label, value]) => (
                              <div key={label}>
                                <dt className="text-muted-foreground">{label}</dt>
                                <dd className="break-all font-mono">{value}</dd>
                              </div>
                            ))}
                          </dl>
                          {Object.keys(entry.details).length > 0 && (
                            <pre className="mt-2 max-h-48 max-w-sm overflow-auto rounded-md bg-muted p-3 text-xs">
                              {JSON.stringify(entry.details, null, 2)}
                            </pre>
                          )}
                        </details>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("noDetails")}</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        )}
        {entries.data && entries.error && <Alert variant="destructive">{message(entries.error)}</Alert>}
        {entries.hasNextPage && (
          <div className="border-t border-border p-4">
            <Button variant="outline" disabled={entries.isFetching} onClick={() => void entries.fetchNextPage()}>
              {t(entries.isFetchingNextPage ? "loading" : "loadMore")}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
