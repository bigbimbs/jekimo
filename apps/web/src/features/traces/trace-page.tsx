import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ErrorState, PageHeader, PageLoader } from "../../components/states";
import { Button } from "../../components/ui/button";
import { Input, NativeSelect } from "../../components/ui/input";
import { TRACE_ID_PATTERN } from "../../constants/tracing";
import { useApi } from "../../lib/api-context";
import { useFormat } from "../../lib/format";
import { useProject } from "../projects/use-project";

export function TracePage() {
  const { t } = useTranslation("traces"),
    api = useApi(),
    project = useProject(),
    format = useFormat();
  const { traceId = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const valid = TRACE_ID_PATTERN.test(traceId);
  const window = useMemo(() => {
    const to = Date.parse(params.get("to") ?? "") || Date.now();
    const requested = Date.parse(params.get("from") ?? "");
    const from =
      Number.isFinite(requested) && requested < to && to - requested <= 7 * 86400000 ? requested : to - 86400000;
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }, [params]);
  const records = useInfiniteQuery({
    queryKey: ["project", project.id, "trace", traceId, window],
    enabled: valid,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listEvents(project.id, { ...window, trace_id: traceId, limit: 100, ...(pageParam && { cursor: pageParam }) }),
    getNextPageParam: (last) => last.next_cursor,
  });
  const rows = records.data?.pages.flatMap((page) => page.events) ?? [];
  return (
    <div className="mx-auto grid max-w-6xl gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader title={t("title")} description={t("intro")} />
      <form
        key={traceId}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const id = String(data.get("traceId")).trim();
          if (!TRACE_ID_PATTERN.test(id)) return;
          const to = Date.now();
          const from = to - Number(data.get("hours")) * 3600000;
          const query = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
          navigate(`/projects/${encodeURIComponent(project.id)}/traces/${id}?${query}`);
        }}
      >
        <label htmlFor="trace-id" className="grid min-w-64 flex-1 gap-1 text-sm">
          {t("id")}
          <Input
            id="trace-id"
            name="traceId"
            defaultValue={traceId}
            required
            pattern="(?!0{32}$)[0-9a-f]{32}"
            maxLength={32}
          />
        </label>
        <label htmlFor="trace-period" className="grid gap-1 text-sm">
          {t("period")}
          <NativeSelect id="trace-period" name="hours" defaultValue="24">
            <option value="24">{t("day")}</option>
            <option value="168">{t("week")}</option>
          </NativeSelect>
        </label>
        <Button type="submit">{t("search")}</Button>
      </form>
      <p className="text-sm text-muted-foreground">{t("limits")}</p>
      {!valid ? (
        <p>{t(traceId ? "invalid" : "setup")}</p>
      ) : records.isPending ? (
        <PageLoader />
      ) : records.isError ? (
        <ErrorState error={records.error} onRetry={() => records.refetch()} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t("window", { from: format.dateTime(window.from), to: format.dateTime(window.to) })}
          </p>
          {rows.length === 0 ? (
            <p>{t("empty")}</p>
          ) : (
            <section className="grid gap-3" aria-label={t("records")}>
              {rows.map(({ event, received_at }) => (
                <article key={event.event_id} className="grid gap-2 rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>{t(event.database ? "query" : event.kind)}</span>
                    <span>{format.dateTime(received_at)}</span>
                    <span>{event.service}</span>
                    <span>{event.environment}</span>
                  </div>
                  <p className="break-words font-medium">{event.message}</p>
                  {event.context?.trace_name && (
                    <p className="text-sm text-muted-foreground">{event.context.trace_name}</p>
                  )}
                  {event.database && (
                    <p className="text-sm">
                      {t("queryResult", {
                        duration: format.number(Math.round(event.database.duration_ms * 100) / 100),
                        status: t(event.database.status),
                      })}
                    </p>
                  )}
                  <details>
                    <summary className="cursor-pointer text-sm text-muted-foreground">{t("details")}</summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-code p-3 text-xs">
                      {JSON.stringify(event, null, 2)}
                    </pre>
                  </details>
                </article>
              ))}
            </section>
          )}
          {records.hasNextPage && (
            <Button
              variant="outline"
              disabled={records.isFetchingNextPage}
              onClick={() => void records.fetchNextPage()}
            >
              {t("more")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
