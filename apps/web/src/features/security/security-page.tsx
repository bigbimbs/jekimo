import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Logo } from "../../components/logo";
import { ErrorState, PageHeader, PageLoader } from "../../components/states";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { useApi } from "../../lib/api-context";
import { queryKeys } from "../../lib/query-keys";
import type { TwoFactorSetup } from "../../types/api";
import type { SecurityAction } from "../../types/security";
import { useSession } from "../auth/session";
import { ThemeToggle } from "../theme/theme-toggle";
import { AuthenticatorSetup } from "./authenticator-setup";
import { SecurityActionDialog } from "./security-action-dialog";

export function SecurityPage() {
  const { t } = useTranslation("security");
  const api = useApi();
  const queryClient = useQueryClient();
  const { user, signOut } = useSession();
  const status = useQuery({ queryKey: queryKeys.twoFactor, queryFn: api.getTwoFactor });
  const [action, setAction] = useState<SecurityAction | null>(null);
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [updated, setUpdated] = useState(false);
  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.twoFactor }),
      queryClient.invalidateQueries({ queryKey: queryKeys.session }),
    ]);
  }
  async function confirm(password: string, code: string) {
    if (action === "setup") setSetup(await api.setupTwoFactor(password));
    else {
      if (action === "disable") await api.disableTwoFactor(password, code);
      else if (action === "regenerate") {
        setCodes((await api.regenerateRecoveryCodes(password, code)).recovery_codes);
        setCopied(false);
      } else await api.setTwoFactorPolicy(action === "require", password, code);
      setUpdated(true);
      await refresh();
    }
  }
  async function enable(code: string) {
    const result = await api.enableTwoFactor(code);
    setSetup(null);
    setCodes(result.recovery_codes);
    setCopied(false);
    await refresh();
  }
  const data = status.data;
  return (
    <div className="min-h-dvh bg-sidebar">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <Logo />
        <div className="flex flex-wrap items-center gap-2">
          <ThemeToggle />
          <Button variant="ghost" onClick={() => void signOut()}>
            {t("signOut")}
          </Button>
        </div>
      </header>
      <main className="mx-auto grid max-w-3xl gap-6 px-4 py-8">
        <PageHeader title={t("title")} description={t("intro")} />
        {data && (!data.required || data.enabled) && (
          <Link to="/" className="text-sm text-primary underline">
            {t("back")}
          </Link>
        )}
        {status.isPending ? (
          <PageLoader />
        ) : status.isError ? (
          <ErrorState error={status.error} onRetry={() => status.refetch()} />
        ) : (
          <>
            {updated && !codes && (
              <p role="status" className="text-sm">
                {t("updated")}
              </p>
            )}
            {codes ? (
              <Card>
                <CardHeader title={t("codesTitle")} description={t("codesIntro")} />
                <div className="grid gap-4 p-5">
                  <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">{codes.join("\n")}</pre>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(codes.join("\n"))
                          .then(() => setCopied(true))
                          .catch(() => setCopied(false));
                      }}
                    >
                      {t(copied ? "copied" : "copy")}
                    </Button>
                    <Button onClick={() => setCodes(null)}>{t("done")}</Button>
                  </div>
                </div>
              </Card>
            ) : setup ? (
              <Card>
                <div className="p-5">
                  <AuthenticatorSetup setup={setup} onVerify={enable} onCancel={() => setSetup(null)} />
                </div>
              </Card>
            ) : (
              <Card>
                <div className="grid gap-4 p-5">
                  <p className="text-sm">
                    {t(status.data.enabled ? "enabled" : status.data.required ? "required" : "optional")}
                  </p>
                  {!status.data.configured && <Alert>{t("unconfigured")}</Alert>}
                  {status.data.enabled ? (
                    <>
                      <p className="text-sm text-muted-foreground">
                        {t("remaining", { count: status.data.recovery_codes_remaining })}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          disabled={!status.data.configured}
                          onClick={() => setAction("regenerate")}
                        >
                          {t("regenerate")}
                        </Button>
                        {!status.data.required && (
                          <Button
                            variant="destructive-ghost"
                            disabled={!status.data.configured}
                            onClick={() => setAction("disable")}
                          >
                            {t("disable")}
                          </Button>
                        )}
                      </div>
                    </>
                  ) : (
                    <Button
                      className="justify-self-start"
                      disabled={!status.data.configured}
                      onClick={() => setAction("setup")}
                    >
                      {t("enable")}
                    </Button>
                  )}
                </div>
              </Card>
            )}
            {user.instance_role === "admin" && !setup && !codes && (
              <Card>
                <CardHeader title={t("policyTitle")} description={t("policyIntro")} />
                <div className="grid gap-4 p-5">
                  <p className="text-sm">{t(status.data.required ? "policyOn" : "policyOff")}</p>
                  {!status.data.enabled && <p className="text-sm text-muted-foreground">{t("enrollFirst")}</p>}
                  <Button
                    className="justify-self-start"
                    variant="outline"
                    disabled={!status.data.enabled || !status.data.configured}
                    onClick={() => setAction(status.data.required ? "optionalPolicy" : "require")}
                  >
                    {t(status.data.required ? "optionalPolicy" : "require")}
                  </Button>
                </div>
              </Card>
            )}
          </>
        )}
        {action && <SecurityActionDialog action={action} onSubmit={confirm} onClose={() => setAction(null)} />}
      </main>
    </div>
  );
}
