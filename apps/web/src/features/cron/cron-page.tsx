import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, PageHeader, PageLoader } from "../../components/states";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input, NativeSelect } from "../../components/ui/input";
import { useApi } from "../../lib/api-context";
import { useFormat } from "../../lib/format";
import type { CronMonitor, CronMonitorInput } from "../../types/cron";
import { useProjectPermissions } from "../projects/permissions";
import { useProject } from "../projects/use-project";

export function CronPage() {
  const { t } = useTranslation("cron");
  const api = useApi();
  const project = useProject();
  const format = useFormat();
  const { permissions } = useProjectPermissions(project.id);
  const manage = permissions.has("settings.manage");
  const monitors = useQuery({
    queryKey: ["project", project.id, "cron"],
    queryFn: () => api.listCronMonitors(project.id),
    refetchInterval: 15000,
  });
  const channels = useQuery({
    queryKey: ["project", project.id, "notification-channels"],
    queryFn: () => api.listNotificationChannels(project.id),
    enabled: manage,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      await monitors.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto grid max-w-5xl gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader title={t("title")} description={t("intro")} />
      {error !== undefined && <ErrorState error={error} />}
      {notice && <Alert>{notice}</Alert>}
      {monitors.isPending ? (
        <PageLoader />
      ) : monitors.isError ? (
        <ErrorState error={monitors.error} />
      ) : (
        <section className="grid gap-3">
          {monitors.data.length === 0 && <p className="text-muted-foreground">{t("empty")}</p>}
          {monitors.data.map((m) => (
            <article key={m.id} className="grid gap-3 rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="me-auto">
                  <h2 className="font-semibold">{m.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    {m.expression} · {m.timezone}
                  </p>
                </div>
                <span
                  className={
                    m.health === "failing" && m.enabled ? "text-sm text-destructive" : "text-sm text-muted-foreground"
                  }
                >
                  {m.enabled ? t(`health.${m.health}`) : t("paused")}
                </span>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">{t("next")}</dt>
                  <dd>{m.enabled ? format.dateTime(m.nextExpectedAt) : t("paused")}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("lastSuccess")}</dt>
                  <dd>{m.lastSuccessAt ? format.dateTime(m.lastSuccessAt) : t("never")}</dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setSelected(selected === m.id ? null : m.id)}>
                  {t(selected === m.id ? "close" : "view")}
                </Button>
                {manage && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => api.enableCronMonitor(project.id, m.id, !m.enabled))}
                  >
                    {t(m.enabled ? "pause" : "resume")}
                  </Button>
                )}
              </div>
              {selected === m.id && <CronDetails projectId={project.id} monitor={m} />}
            </article>
          ))}
        </section>
      )}
      {manage && (
        <form
          className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const input: CronMonitorInput = {
              name: String(data.get("name")),
              expression: String(data.get("expression")),
              timezone: String(data.get("timezone")),
              graceSeconds: Number(data.get("graceSeconds")),
              maxRuntimeSeconds: Number(data.get("maxRuntimeSeconds")),
              failureThreshold: Number(data.get("failureThreshold")),
              recoveryThreshold: Number(data.get("recoveryThreshold")),
              channelId: String(data.get("channel")) || null,
            };
            void run(async () => {
              const created = await api.createCronMonitor(project.id, input);
              form.reset();
              setSelected(created.id);
              setNotice(t("saved"));
            });
          }}
        >
          <h2 className="font-semibold sm:col-span-2">{t("create")}</h2>
          {(["name", "expression", "timezone"] as const).map((field) => (
            <label key={field} htmlFor={`cron-${field}`} className="grid gap-1 text-sm">
              {t(field)}
              <Input
                id={`cron-${field}`}
                name={field}
                required
                maxLength={field === "expression" ? 128 : 100}
                defaultValue={field === "timezone" ? "UTC" : field === "expression" ? "0 2 * * *" : ""}
              />
            </label>
          ))}
          <p className="text-xs text-muted-foreground sm:col-span-2">{t("scheduleHint")}</p>
          {(["graceSeconds", "maxRuntimeSeconds", "failureThreshold", "recoveryThreshold"] as const).map((field) => (
            <label key={field} htmlFor={`cron-${field}`} className="grid gap-1 text-sm">
              {t(field)}
              <Input
                id={`cron-${field}`}
                name={field}
                type="number"
                required
                min={field === "graceSeconds" ? 0 : 1}
                max={field === "graceSeconds" ? 86400 : field === "maxRuntimeSeconds" ? 604800 : 100}
                defaultValue={field === "graceSeconds" ? 60 : field === "maxRuntimeSeconds" ? 300 : 1}
              />
            </label>
          ))}
          <label htmlFor="cron-channel" className="grid gap-1 text-sm sm:col-span-2">
            {t("channel")}
            <NativeSelect id="cron-channel" name="channel">
              <option value="">{t("noChannel")}</option>
              {channels.data
                ?.filter((c) => c.enabled)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </NativeSelect>
            <span className="text-xs text-muted-foreground">{t("connectionsHint")}</span>
          </label>
          {channels.isError && <ErrorState error={channels.error} />}
          <Button type="submit" disabled={busy} className="sm:col-span-2">
            {t("create")}
          </Button>
        </form>
      )}
    </div>
  );
}
function CronDetails({ projectId, monitor }: { projectId: string; monitor: CronMonitor }) {
  const { t } = useTranslation("cron");
  const api = useApi();
  const format = useFormat();
  const runs = useQuery({
    queryKey: ["project", projectId, "cron-runs", monitor.id],
    queryFn: () => api.listCronRuns(projectId, monitor.id),
    refetchInterval: 10000,
  });
  return (
    <div className="grid gap-4 border-t border-border pt-4">
      <section className="grid gap-2">
        <h3 className="font-medium">{t("setup")}</h3>
        <p className="text-sm text-muted-foreground">{t("setupHint")}</p>
        <dl className="grid gap-2 text-xs">
          <div>
            <dt>{t("monitorId")}</dt>
            <dd className="break-all font-mono">{monitor.id}</dd>
          </div>
          <div>
            <dt>{t("endpoint")}</dt>
            <dd className="break-all font-mono">POST /api/v1/cron/{monitor.id}/check-ins</dd>
          </div>
        </dl>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify({ run_id: "00000000-0000-4000-8000-000000000001", status: "started" }, null, 2)}
        </pre>
      </section>
      <section className="grid gap-3">
        <div className="flex justify-between gap-3">
          <h3 className="font-medium">{t("history")}</h3>
          <Button variant="outline" onClick={() => void runs.refetch()}>
            {t("refresh")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("historyHint")}</p>
        {runs.isError && <ErrorState error={runs.error} />}
        {runs.data?.length === 0 && <p className="text-sm">{t("noRuns")}</p>}
        {runs.data?.map((r) => (
          <div key={r.id} className="grid gap-2 rounded-md bg-muted/40 p-3 text-sm sm:grid-cols-2">
            <p className="font-medium">{t(`status.${r.status}`)}</p>
            <p className="text-muted-foreground">
              {format.dateTime(r.startedAt ?? r.expectedAt ?? r.finishedAt ?? "")}
            </p>
            {r.startedAt && r.finishedAt && (
              <p>
                {t("duration")}:{" "}
                {t("seconds", {
                  count: Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)),
                })}
              </p>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
