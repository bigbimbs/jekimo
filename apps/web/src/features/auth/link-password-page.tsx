import { useMutation } from "@tanstack/react-query";
import { CheckCircle2Icon, LinkIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { EmptyState } from "../../components/states";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { PASSWORD_MAX_CHARS, PASSWORD_MIN_CHARS } from "../../constants/passwords";
import { useApi } from "../../lib/api-context";
import { useErrorMessage } from "../../lib/errors";
import type { PasswordProblem } from "../../types/auth";
import { AuthLayout } from "./auth-layout";
import { useLinkToken } from "./link-token";
import { passwordProblem } from "./password";
import { PasswordFields } from "./password-fields";

/** The invitation (`/invite`) and password reset (`/reset-password`) pages: both set a password from a link token. */
export function LinkPasswordPage({ mode }: { mode: "invite" | "reset" }) {
  const { t } = useTranslation("auth");
  const api = useApi();
  const message = useErrorMessage();
  const token = useLinkToken();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<PasswordProblem | null>(null);

  const submit = useMutation({
    mutationFn: (value: { token: string; password: string }) =>
      mode === "invite"
        ? api.acceptInvitation(value.token, value.password)
        : api.resetPassword(value.token, value.password),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const found = passwordProblem(password, confirm);
    setProblem(found);
    if (!found && token) submit.mutate({ token, password });
  }

  const toSignIn = (
    <Button asChild>
      <Link to="/sign-in">{t("toSignIn")}</Link>
    </Button>
  );

  if (!token) {
    return (
      <AuthLayout title={t(`${mode}.title`)}>
        <EmptyState className="py-4" icon={<LinkIcon />} title={t("link.missingTitle")} body={t("link.missingBody")} />
      </AuthLayout>
    );
  }

  if (submit.isSuccess) {
    return (
      <AuthLayout title={t(`${mode}.doneTitle`)}>
        <EmptyState className="py-4" icon={<CheckCircle2Icon />} title={t(`${mode}.doneBody`)} action={toSignIn} />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t(`${mode}.title`)} intro={t(`${mode}.intro`)}>
      <form className="grid gap-4" onSubmit={onSubmit}>
        {problem && (
          <Alert variant="destructive">
            {t(`password.${problem}`, { min: PASSWORD_MIN_CHARS, max: PASSWORD_MAX_CHARS })}
          </Alert>
        )}
        {submit.isError && <Alert variant="destructive">{message(submit.error)}</Alert>}
        <PasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
        <Button type="submit" className="mt-2 w-full" disabled={submit.isPending}>
          {submit.isPending ? t(`${mode}.submitting`) : t(`${mode}.submit`)}
        </Button>
      </form>
    </AuthLayout>
  );
}
