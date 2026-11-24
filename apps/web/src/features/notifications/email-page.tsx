import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, PageLoader } from "../../components/states";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input, NativeSelect } from "../../components/ui/input";
import { useApi } from "../../lib/api-context";
import type { EmailSettings } from "../../types/notifications";
import { AdminShell } from "../admin/admin-shell";
import { DeliveryHistory } from "./delivery-history";

export function EmailPage() {
  const { t } = useTranslation("notifications");
  return (
    <AdminShell title={t("emailTitle")} description={t("emailIntro")}>
      <EmailContent />
    </AdminShell>
  );
}
function EmailContent() {
  const { t } = useTranslation("notifications");
  const api = useApi();
  const query = useQuery({ queryKey: ["admin", "email"], queryFn: api.getEmailSettings });
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  if (query.isPending) return <PageLoader />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const settings = query.data.settings;
  return (
    <div className="grid max-w-3xl gap-6">
      {!query.data.available && <Alert variant="warning">{t("unavailable")}</Alert>}
      {error !== undefined && <ErrorState error={error} />}
      {notice && <Alert>{notice}</Alert>}
      <form
        key={query.dataUpdatedAt}
        className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          setBusy(true);
          setError(undefined);
          setNotice("");
          const password = String(data.get("password") ?? "");
          const input: EmailSettings = {
            host: String(data.get("host")),
            port: Number(data.get("port")),
            security: data.get("security") as EmailSettings["security"],
            username: String(data.get("username")),
            from: String(data.get("from")),
            fromName: String(data.get("fromName")),
            enabled: data.get("enabled") === "on",
            ...(password ? { password } : {}),
          };
          try {
            await api.saveEmailSettings(input);
            form.reset();
            await query.refetch();
            setNotice(t("saved"));
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {(["host", "port", "username", "from", "fromName"] as const).map((name) => (
          <label htmlFor={`email-${name}`} className="grid gap-1 text-sm" key={name}>
            {t(name)}
            <Input
              id={`email-${name}`}
              name={name}
              type={name === "port" ? "number" : name === "from" ? "email" : "text"}
              required={name !== "username"}
              defaultValue={settings?.[name] ?? (name === "port" ? 587 : name === "fromName" ? "Jekimo" : "")}
              min={name === "port" ? 1 : undefined}
              max={name === "port" ? 65535 : undefined}
            />
          </label>
        ))}
        <label htmlFor="email-page-field-2" className="grid gap-1 text-sm">
          {t("security")}
          <NativeSelect id="email-page-field-2" name="security" defaultValue={settings?.security ?? "starttls"}>
            <option value="starttls">{t("starttls")}</option>
            <option value="tls">{t("tls")}</option>
          </NativeSelect>
        </label>
        <label htmlFor="email-page-field-3" className="grid gap-1 text-sm sm:col-span-2">
          {t("password")}
          <Input id="email-page-field-3" name="password" type="password" autoComplete="new-password" />
          <span className="text-xs text-muted-foreground">{t("passwordHint")}</span>
        </label>
        <label className="flex gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={settings?.enabled ?? true} />
          {t("enabled")}
        </label>
        <Button disabled={busy || !query.data.available} type="submit">
          {t("save")}
        </Button>
      </form>
      <form
        className="grid gap-3 rounded-lg border border-border p-4"
        onSubmit={async (event) => {
          event.preventDefault();
          const recipient = String(new FormData(event.currentTarget).get("recipient"));
          setBusy(true);
          setError(undefined);
          setNotice("");
          try {
            await api.testEmail(recipient);
            setNotice(t("queued"));
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="email-page-field-4" className="grid gap-1 text-sm">
          {t("recipient")}
          <Input id="email-page-field-4" type="email" name="recipient" required />
        </label>
        <Button type="submit" disabled={busy || !settings?.enabled}>
          {t("test")}
        </Button>
      </form>
      <DeliveryHistory />
    </div>
  );
}
