import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, LogInIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useApi } from "../../lib/api-context";
import { useErrorMessage } from "../../lib/errors";
import { queryKeys } from "../../lib/query-keys";
import { safeNextPath } from "../../lib/utils";
import { AuthLayout, Field } from "./auth-layout";

export function SignInPage() {
  const { t } = useTranslation("auth");
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const message = useErrorMessage();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signIn = useMutation({
    mutationFn: () => api.login(email.trim(), password),
    onSuccess: (session) => {
      queryClient.clear();
      queryClient.setQueryData(queryKeys.session, session);
      navigate(safeNextPath(params.get("next")), { replace: true });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    signIn.mutate();
  }

  return (
    <AuthLayout icon={<LogInIcon aria-hidden="true" />} title={t("signIn.title")}>
      <form className="grid gap-4" onSubmit={submit} noValidate={false}>
        {signIn.isError && <Alert variant="destructive">{message(signIn.error)}</Alert>}
        <Field id="email" label={t("signIn.email")}>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field id="password" label={t("signIn.password")}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" className="mt-1 w-full" disabled={signIn.isPending}>
          {signIn.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          {signIn.isPending ? t("signIn.submitting") : t("signIn.submit")}
        </Button>
        <p className="border-t border-border pt-4 text-center text-xs leading-relaxed text-muted-foreground">
          {t("signIn.forgot")}
        </p>
      </form>
    </AuthLayout>
  );
}
