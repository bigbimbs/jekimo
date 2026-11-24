import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, PageHeader, PageLoader } from "../../components/states";
import { Button } from "../../components/ui/button";
import { Input, NativeSelect } from "../../components/ui/input";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useApi } from "../../lib/api-context";
import { useFormat } from "../../lib/format";
import { useProject } from "../projects/use-project";
import { TraceLink } from "../traces/trace-link";

export function DatabasePage() {
  const { t } = useTranslation("database");
  const api = useApi();
  const project = useProject();
  const format = useFormat();
  const [filter, setFilter] = useState(() => ({ hours: 24, slowMs: 200, environment: "", at: Date.now() }));
  const query = {
    from: new Date(filter.at - filter.hours * 3600000).toISOString(),
    to: new Date(filter.at).toISOString(),
    slow_ms: filter.slowMs,
    ...(filter.environment && { environment: filter.environment }),
  };
  const result = useQuery({
    queryKey: ["project", project.id, "database", query],
    queryFn: () => api.getDatabaseSummary(project.id, query),
  });
  const ms = (n: number) => t("milliseconds", { value: format.number(Math.round(n * 100) / 100) });
  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader title={t("title")} description={t("intro")} />
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setFilter({
            hours: Number(data.get("hours")),
            slowMs: Number(data.get("slowMs")),
            environment: String(data.get("environment")).trim(),
            at: Date.now(),
          });
        }}
      >
        <label className="grid gap-1 text-sm" htmlFor="database-window">
          {t("window")}
          <NativeSelect id="database-window" name="hours" defaultValue="24">
            <option value="1">{t("hour")}</option>
            <option value="24">{t("day")}</option>
            <option value="168">{t("week")}</option>
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-sm" htmlFor="database-threshold">
          {t("threshold")}
          <Input
            id="database-threshold"
            name="slowMs"
            type="number"
            min="0"
            max="604800000"
            step="any"
            defaultValue="200"
            required
          />
        </label>
        <label className="grid gap-1 text-sm" htmlFor="database-environment">
          {t("environment")}
          <Input id="database-environment" name="environment" maxLength={128} placeholder={t("allEnvironments")} />
        </label>
        <Button type="submit" disabled={result.isFetching}>
          {t("apply")}
        </Button>
      </form>
      {result.isPending ? (
        <PageLoader />
      ) : result.isError ? (
        <ErrorState error={result.error} onRetry={() => result.refetch()} />
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {(
              [
                ["count", format.number(result.data.totals.count)],
                ["errors", format.number(result.data.totals.errors)],
                ["slow", format.number(result.data.totals.slow)],
                ["average", ms(result.data.totals.averageMs)],
                ["p95", ms(result.data.totals.p95Ms)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border p-4">
                <dt className="text-sm text-muted-foreground">{t(label)}</dt>
                <dd className="mt-2 text-2xl font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted-foreground">{t("sampled")}</p>
          {result.data.totals.count === 0 ? (
            <div className="rounded-lg border border-border p-6">
              <h2 className="font-semibold">{t("empty")}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{t("setup")}</p>
            </div>
          ) : (
            <>
              <section className="grid gap-3">
                <h2 className="font-semibold">{t("groups")}</h2>
                <p className="text-sm text-muted-foreground">{t("groupsHint")}</p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {(
                          ["name", "system", "operation", "count", "errors", "slow", "average", "p95", "total"] as const
                        ).map((key) => (
                          <TableHead key={key}>{t(key)}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <tbody>
                      {result.data.groups.map((g) => (
                        <TableRow key={JSON.stringify([g.name, g.system, g.operation])}>
                          <TableCell>
                            <span className="break-all font-medium">{g.name}</span>
                          </TableCell>
                          <TableCell>{g.system}</TableCell>
                          <TableCell>{t(`operations.${g.operation}`)}</TableCell>
                          <TableCell>{format.number(g.count)}</TableCell>
                          <TableCell>{format.number(g.errors)}</TableCell>
                          <TableCell>{format.number(g.slow)}</TableCell>
                          <TableCell>{ms(g.averageMs)}</TableCell>
                          <TableCell>{ms(g.p95Ms)}</TableCell>
                          <TableCell>{ms(g.totalMs)}</TableCell>
                        </TableRow>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </section>
              <section className="grid gap-3">
                <h2 className="font-semibold">{t("recent")}</h2>
                <p className="text-sm text-muted-foreground">{t("recentHint")}</p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {(["name", "duration", "status", "service", "environment", "received"] as const).map((key) => (
                          <TableHead key={key}>{t(key)}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <tbody>
                      {result.data.recent.map((r) => (
                        <TableRow key={r.event.event_id}>
                          <TableCell>
                            <div className="grid gap-1">
                              {r.event.database?.name}
                              <TraceLink
                                projectId={project.id}
                                traceId={r.event.context?.trace_id}
                                receivedAt={r.received_at}
                              />
                            </div>
                          </TableCell>
                          <TableCell>{ms(r.event.database?.duration_ms ?? 0)}</TableCell>
                          <TableCell>{t(r.event.database?.status === "error" ? "failed" : "completed")}</TableCell>
                          <TableCell>{r.event.service ?? "—"}</TableCell>
                          <TableCell>{r.event.environment ?? "—"}</TableCell>
                          <TableCell>{format.dateTime(r.received_at)}</TableCell>
                        </TableRow>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
