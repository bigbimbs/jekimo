import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { EmptyState, ErrorState, PageLoader } from "../../components/states";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { PASSWORD_MAX_CHARS, PASSWORD_MIN_CHARS } from "../../constants/passwords";
import { useApi } from "../../lib/api-context";
import { useErrorMessage } from "../../lib/errors";
import { queryKeys } from "../../lib/query-keys";
import type { IssuedKey } from "../../types/api";
import type { PasswordProblem } from "../../types/auth";
import { SecretKey } from "../settings/secret-key";
import { AuthLayout, Field } from "./auth-layout";
import { passwordProblem } from "./password";
import { PasswordFields } from "./password-fields";

export function SetupPage() {
  const { t } = useTranslation("auth");
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const message = useErrorMessage();
  const setup = useQuery({ queryKey: queryKeys.setup, queryFn: api.setupRequired, retry: false });
  const [form, setForm] = useState({ token: "", email: "", project: "" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<PasswordProblem | null>(null);
  const [issued, setIssued] = useState<{ key: IssuedKey; project: string } | null>(null);

  const complete = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      const email = form.email.trim();
      const result = await api.completeSetup({
        setup_token: form.token.trim(),
        email,
        password,
        project_name: form.project.trim(),
      });
      const session = await api.login(email, password).catch(() => null);
      return { result, session };
    },
    onSuccess: ({ result, session }) => {
      queryClient.setQueryData(queryKeys.setup, false);
      if (session) queryClient.setQueryData(queryKeys.session, session);
      setIssued({ key: result.ingestion_key, project: result.project.name });
      setPassword("");
      setConfirm("");
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const found = passwordProblem(password, confirm);
    setProblem(found);
    if (!found) complete.mutate();
  }

  if (issued) {
    return (
      <AuthLayout title={t("setup.doneTitle")} intro={t("setup.doneBody", { project: issued.project })}>
        <div className="grid gap-5">
          <SecretKey issued={issued.key} />
          <Button
            onClick={() => {
              setIssued(null);
              navigate("/", { replace: true });
            }}
          >
            {t("setup.continue")}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (setup.isPending) return <PageLoader className="min-h-dvh" />;
  if (setup.isError)
    return <ErrorState className="min-h-dvh justify-center" error={setup.error} onRetry={() => setup.refetch()} />;
  if (!setup.data) {
    return (
      <AuthLayout title={t("setup.closedTitle")}>
        <EmptyState
          className="py-4"
          icon={<CheckCircle2Icon />}
          title={t("setup.closedBody")}
          action={
            <Button asChild>
              <Link to="/sign-in">{t("toSignIn")}</Link>
            </Button>
          }
        />
      </AuthLayout>
    );
  }

  const update = (name: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [name]: e.target.value }));

  return (
    <AuthLayout title={t("setup.title")} intro={t("setup.intro")}>
      <form className="grid gap-4" onSubmit={onSubmit}>
        {problem && (
          <Alert variant="destructive">
            {t(`password.${problem}`, { min: PASSWORD_MIN_CHARS, max: PASSWORD_MAX_CHARS })}
          </Alert>
        )}
        {complete.isError && <Alert variant="destructive">{message(complete.error)}</Alert>}
        <Field id="setup-token" label={t("setup.token")} hint={t("setup.tokenHint")}>
          <Input
            id="setup-token"
            required
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-describedby="setup-token-hint"
            value={form.token}
            onChange={update("token")}
          />
        </Field>
        <Field id="setup-email" label={t("setup.email")}>
          <Input
            id="setup-email"
            type="email"
            autoComplete="username"
            required
            value={form.email}
            onChange={update("email")}
          />
        </Field>
        <PasswordFields
          password={password}
          confirm={confirm}
          onPassword={setPassword}
          onConfirm={setConfirm}
          label={t("setup.password")}
        />
        <Field id="setup-project" label={t("setup.projectName")}>
          <Input id="setup-project" required maxLength={128} value={form.project} onChange={update("project")} />
        </Field>
        <Button type="submit" className="mt-2 w-full" disabled={complete.isPending}>
          {complete.isPending ? t("setup.submitting") : t("setup.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
