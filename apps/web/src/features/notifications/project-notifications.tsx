import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState, ErrorState, PageHeader, PageLoader } from "../../components/states";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input, NativeSelect } from "../../components/ui/input";
import { useApi } from "../../lib/api-context";
import type { AlertRule, NotificationChannel } from "../../types/notifications";
import { useProjectPermissions } from "../projects/permissions";
import { useProject } from "../projects/use-project";
import { DeliveryHistory } from "./delivery-history";

export function ProjectNotifications({ page }: { page: "alerts" | "integrations" }) {
  const { t } = useTranslation("notifications");
  const project = useProject();
  const { permissions, isPending } = useProjectPermissions(project.id);
  return (
    <div className="mx-auto grid max-w-5xl gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        title={t(page === "alerts" ? "alertsTitle" : "integrationsTitle")}
        description={t(page === "alerts" ? "alertsIntro" : "integrationsIntro")}
      />
      {isPending ? (
        <PageLoader />
      ) : permissions.has("settings.manage") ? (
        <ProjectContent key={`${project.id}/${page}`} projectId={project.id} page={page} />
      ) : (
        <EmptyState title={t("noAccess")} />
      )}
    </div>
  );
}
function ProjectContent({ projectId, page }: { projectId: string; page: "alerts" | "integrations" }) {
  const { t } = useTranslation("notifications");
  const api = useApi();
  const channels = useQuery({
    queryKey: ["project", projectId, "notification-channels"],
    queryFn: () => api.listNotificationChannels(projectId),
  });
  const rules = useQuery({
    queryKey: ["project", projectId, "alert-rules"],
    queryFn: () => api.listAlertRules(projectId),
    enabled: page === "alerts",
  });
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [trigger, setTrigger] = useState<AlertRule["trigger"]>("new_issue");
  const [kind, setKind] = useState<NotificationChannel["kind"]>("email");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function run(action: () => Promise<unknown>, success = "") {
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      await action();
      await channels.refetch();
      if (page === "alerts") await rules.refetch();
      setNotice(success);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  if (channels.isPending) return <PageLoader />;
  if (channels.isError) return <ErrorState error={channels.error} onRetry={() => void channels.refetch()} />;
  return (
    <>
      {error !== undefined && <ErrorState error={error} />}
      {notice && <Alert>{notice}</Alert>}
      {page === "integrations" ? (
        <>
          <section className="grid gap-3">
            <h2 className="font-semibold">{t("channels")}</h2>
            {channels.data.length === 0 && <p className="text-sm text-muted-foreground">{t("noChannels")}</p>}
            {channels.data.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4">
                <div className="me-auto">
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(c.kind)} · {t(c.enabled ? "enabled" : "disabled")}
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={busy || !c.enabled}
                  onClick={() => void run(() => api.testNotificationChannel(projectId, c.id), t("queued"))}
                >
                  {t("test")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => api.enableNotificationChannel(projectId, c.id, !c.enabled))}
                >
                  {t(c.enabled ? "disable" : "enable")}
                </Button>
              </div>
            ))}
          </section>
          <form
            className="grid gap-4 rounded-lg border border-border p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              void run(async () => {
                await api.createNotificationChannel(projectId, {
                  name: String(data.get("name")),
                  kind,
                  destination: String(data.get("destination")),
                  ...(kind === "webhook" ? { signingSecret: String(data.get("signingSecret")) } : {}),
                });
                form.reset();
              }, t("saved"));
            }}
          >
            <label htmlFor="project-notifications-field-1" className="grid gap-1 text-sm">
              {t("name")}
              <Input id="project-notifications-field-1" name="name" required maxLength={100} />
            </label>
            <label htmlFor="project-notifications-field-2" className="grid gap-1 text-sm">
              {t("kind")}
              <NativeSelect
                id="project-notifications-field-2"
                value={kind}
                onChange={(e) => setKind(e.target.value as NotificationChannel["kind"])}
              >
                {(["email", "slack", "webhook"] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(k)}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label htmlFor="project-notifications-field-3" className="grid gap-1 text-sm">
              {t(kind === "email" ? "destinationEmail" : "destinationWebhook")}
              <Input
                id="project-notifications-field-3"
                key={kind}
                type={kind === "email" ? "email" : "password"}
                autoComplete="off"
                name="destination"
                required
                maxLength={2048}
              />
            </label>
            {kind === "webhook" && (
              <label htmlFor="project-notifications-field-4" className="grid gap-1 text-sm">
                {t("signingSecret")}
                <Input
                  id="project-notifications-field-4"
                  type="password"
                  name="signingSecret"
                  required
                  minLength={32}
                  maxLength={256}
                  autoComplete="new-password"
                />
                <span className="text-xs text-muted-foreground">{t("secretHint")}</span>
              </label>
            )}
            <p className="text-xs text-muted-foreground">{t("channelHint")}</p>
            <Button type="submit" disabled={busy}>
              {t("createChannel")}
            </Button>
          </form>
        </>
      ) : (
        <>
          {rules.isError && <ErrorState error={rules.error} />}
          <section className="grid gap-3">
            <h2 className="font-semibold">{t("rules")}</h2>
            {rules.data?.length === 0 && <p className="text-sm text-muted-foreground">{t("noRules")}</p>}
            {rules.data?.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4">
                <div className="me-auto">
                  <p className="font-medium">{r.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {t(r.trigger)} · {channels.data.find((c) => c.id === r.channelId)?.name}
                  </p>
                  {r.trigger === "slow_query" && (
                    <p className="text-sm text-muted-foreground">
                      {t("queryRuleSummary", {
                        threshold: r.thresholdMs,
                        environment: r.environment ?? t("allEnvironments"),
                        name: r.queryName ?? t("allOperations"),
                      })}
                    </p>
                  )}
                  <p className="text-xs">{t(r.enabled ? "enabled" : "disabled")}</p>
                </div>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.saveAlertRule(projectId, { ...r, enabled: !r.enabled }, r.id);
                      if (editing?.id === r.id) setEditing({ ...r, enabled: !r.enabled });
                    })
                  }
                >
                  {t(r.enabled ? "disable" : "enable")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setEditing(r);
                    setTrigger(r.trigger);
                  }}
                >
                  {t("editRule")}
                </Button>
              </div>
            ))}
          </section>
          {channels.data.length === 0 ? (
            <Alert>{t("noChannels")}</Alert>
          ) : (
            <form
              key={editing?.id ?? "new-rule"}
              className="grid gap-4 rounded-lg border border-border p-4"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                void run(async () => {
                  await api.saveAlertRule(
                    projectId,
                    {
                      ...(trigger === "slow_query" && {
                        thresholdMs: Number(data.get("thresholdMs")),
                        ...(String(data.get("environment") ?? "").trim() && {
                          environment: String(data.get("environment")).trim(),
                        }),
                        ...(String(data.get("queryName") ?? "").trim() && {
                          queryName: String(data.get("queryName")).trim(),
                        }),
                      }),
                      name: String(data.get("name")),
                      channelId: String(data.get("channel")),
                      trigger,
                      cooldownMinutes: Number(data.get("cooldown")),
                      enabled: editing?.enabled ?? true,
                    },
                    editing?.id,
                  );
                  form.reset();
                  setEditing(null);
                  setTrigger("new_issue");
                }, t("saved"));
              }}
            >
              <label htmlFor="project-notifications-field-5" className="grid gap-1 text-sm">
                {t("name")}
                <Input
                  id="project-notifications-field-5"
                  name="name"
                  required
                  maxLength={100}
                  defaultValue={editing?.name ?? ""}
                />
              </label>
              <label htmlFor="project-notifications-field-6" className="grid gap-1 text-sm">
                {t("channel")}
                <NativeSelect
                  id="project-notifications-field-6"
                  name="channel"
                  required
                  defaultValue={editing?.channelId ?? ""}
                >
                  <option value="" disabled>
                    {t("chooseChannel")}
                  </option>
                  {channels.data
                    .filter((c) => c.enabled || c.id === editing?.channelId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </NativeSelect>
              </label>
              <label htmlFor="project-notifications-field-7" className="grid gap-1 text-sm">
                {t("trigger")}
                <NativeSelect
                  id="project-notifications-field-7"
                  name="trigger"
                  value={trigger}
                  onChange={(e) => setTrigger(e.target.value as AlertRule["trigger"])}
                >
                  <option value="new_issue">{t("new_issue")}</option>
                  <option value="regression">{t("regression")}</option>
                  <option value="slow_query">{t("slow_query")}</option>
                </NativeSelect>
              </label>
              {trigger === "slow_query" && (
                <>
                  <label htmlFor="slow-query-threshold" className="grid gap-1 text-sm">
                    {t("queryThreshold")}
                    <Input
                      id="slow-query-threshold"
                      name="thresholdMs"
                      type="number"
                      min={1}
                      max={604800000}
                      required
                      defaultValue={editing?.thresholdMs ?? 200}
                    />
                  </label>
                  <label htmlFor="slow-query-environment" className="grid gap-1 text-sm">
                    {t("queryEnvironment")}
                    <Input
                      id="slow-query-environment"
                      name="environment"
                      maxLength={128}
                      defaultValue={editing?.environment ?? ""}
                      placeholder={t("allEnvironments")}
                    />
                  </label>
                  <label htmlFor="slow-query-name" className="grid gap-1 text-sm">
                    {t("queryName")}
                    <Input
                      id="slow-query-name"
                      name="queryName"
                      maxLength={128}
                      defaultValue={editing?.queryName ?? ""}
                      placeholder={t("allOperations")}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">{t("queryAlertHint")}</p>
                </>
              )}
              <label htmlFor="project-notifications-field-8" className="grid gap-1 text-sm">
                {t(trigger === "slow_query" ? "queryCooldown" : "cooldown")}
                <Input
                  id="project-notifications-field-8"
                  name="cooldown"
                  type="number"
                  required
                  min={1}
                  max={1440}
                  defaultValue={editing?.cooldownMinutes ?? 15}
                />
              </label>
              <Button type="submit" disabled={busy}>
                {t(editing ? "updateRule" : "createRule")}
              </Button>
              {editing && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setEditing(null);
                    setTrigger("new_issue");
                  }}
                >
                  {t("cancelEdit")}
                </Button>
              )}
            </form>
          )}
        </>
      )}
      <DeliveryHistory projectId={projectId} />
    </>
  );
}
