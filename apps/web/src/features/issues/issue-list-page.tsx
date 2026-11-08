import { useInfiniteQuery } from "@tanstack/react-query";
import { InboxIcon, SearchXIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { EmptyState, ErrorState } from "../../components/states";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableCell, TableHead, TableRow } from "../../components/ui/table";
import { ALL, ISSUE_PAGE_SIZE } from "../../constants/issues";
import { useApi } from "../../lib/api-context";
import { useErrorMessage } from "../../lib/errors";
import { useFormat } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import type { IssueFilters as Filters } from "../../types/issues";
import { useProject } from "../projects/use-project";
import { KindBadge, SeverityBadge, StatusBadge } from "./badges";
import { DEFAULT_FILTERS, filtersFromParams, filtersToParams, issueQuery } from "./filters";
import { IssueFilters } from "./issue-filters";

export function IssueListPage() {
  const { t } = useTranslation("issues");
  const api = useApi();
  const project = useProject();
  const format = useFormat();
  const message = useErrorMessage();
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);

  const issues = useInfiniteQuery({
    queryKey: queryKeys.issues(project.id, filters),
    queryFn: ({ pageParam }) => api.listIssues(project.id, issueQuery(filters, ISSUE_PAGE_SIZE, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
  });

  const rows = issues.data?.pages.flatMap((p) => p.issues) ?? [];
  const filtered = (Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]).some(
    (k) => k !== "status" && filters[k] !== DEFAULT_FILTERS[k],
  );
  const base = `/projects/${encodeURIComponent(project.id)}`;
  // With one status selected the column repeats the filter, so narrow screens drop it.
  const statusColumn = filters.status === ALL ? undefined : "hidden xl:table-cell";

  let body: ReactNode;
  if (issues.isPending) {
    body = (
      <div className="grid gap-3 p-4">
        {Array.from({ length: 8 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  } else if (!issues.data) {
    body = <ErrorState error={issues.error} onRetry={() => issues.refetch()} />;
  } else if (rows.length === 0) {
    body =
      filtered || filters.status !== "unresolved" ? (
        <EmptyState icon={<SearchXIcon />} title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <EmptyState
          icon={<InboxIcon />}
          title={t("noneTitle")}
          body={t("noneBody")}
          action={
            <Button asChild variant="outline">
              <Link to={`${base}/settings`}>{t("toSettings")}</Link>
            </Button>
          }
        />
      );
  } else {
    body = (
      <>
        <Table>
          <caption className="sr-only">{t("table.caption", { project: project.name })}</caption>
          <thead>
            <TableRow>
              <TableHead className="w-full">{t("table.issue")}</TableHead>
              <TableHead>{t("table.severity")}</TableHead>
              <TableHead className={statusColumn}>{t("table.status")}</TableHead>
              <TableHead className="text-end">{t("table.events")}</TableHead>
              <TableHead>{t("table.lastSeen")}</TableHead>
              <TableHead className="hidden lg:table-cell">{t("table.firstSeen")}</TableHead>
            </TableRow>
          </thead>
          <tbody>
            {rows.map((issue) => (
              <TableRow key={issue.id} className="hover:bg-muted/50">
                <TableCell className="min-w-64 max-w-0">
                  <Link
                    to={`${base}/issues/${encodeURIComponent(issue.id)}`}
                    className="block truncate font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                  >
                    {issue.title}
                  </Link>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <KindBadge kind={issue.kind} />
                    {issue.environments.length > 0 && <span className="truncate">{issue.environments.join(", ")}</span>}
                  </div>
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={issue.last_severity} />
                </TableCell>
                <TableCell className={statusColumn}>
                  <StatusBadge status={issue.status} />
                </TableCell>
                <TableCell className="text-end tabular-nums">{format.number(issue.event_count)}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  <time dateTime={issue.last_seen} title={format.dateTime(issue.last_seen)}>
                    {format.relative(issue.last_seen)}
                  </time>
                </TableCell>
                <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                  <time dateTime={issue.first_seen} title={format.dateTime(issue.first_seen)}>
                    {format.relative(issue.first_seen)}
                  </time>
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
        {(issues.hasNextPage || issues.isFetchNextPageError) && (
          <div className="flex flex-col items-center gap-2 border-t border-border p-4">
            {issues.isFetchNextPageError && <p className="text-sm text-destructive">{message(issues.error)}</p>}
            <Button variant="outline" onClick={() => issues.fetchNextPage()} disabled={issues.isFetchingNextPage}>
              {t("loadMore")}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="mx-auto grid max-w-7xl gap-6 p-6 lg:p-8">
      <header className="grid gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <IssueFilters filters={filters} onChange={(next) => setParams(filtersToParams(next), { replace: true })} />
      </header>
      <section className="rounded-lg border border-border" aria-busy={issues.isFetching}>
        {body}
      </section>
    </div>
  );
}
