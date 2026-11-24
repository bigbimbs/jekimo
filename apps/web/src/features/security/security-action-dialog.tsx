import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { useErrorMessage } from "../../lib/errors";
import type { SecurityAction } from "../../types/security";
import { Field } from "../auth/auth-layout";

export function SecurityActionDialog({
  action,
  onSubmit,
  onClose,
}: {
  action: SecurityAction;
  onSubmit(password: string, code: string): Promise<void>;
  onClose(): void;
}) {
  const { t } = useTranslation("security");
  const { t: tc } = useTranslation();
  const message = useErrorMessage();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: () => onSubmit(password, code.trim()),
    onSuccess: () => {
      setPassword("");
      setCode("");
      onClose();
    },
  });
  const title = action === "setup" ? t("enable") : t(action);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!mutation.isPending) mutation.mutate();
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent closeLabel={tc("actions.close")}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{t("confirmIntro")}</DialogDescription>
          </DialogHeader>
          {action !== "setup" && (
            <Alert>
              {t(
                action === "disable"
                  ? "disableWarning"
                  : action === "regenerate"
                    ? "regenerateWarning"
                    : "policyWarning",
              )}
            </Alert>
          )}
          {mutation.error && <Alert variant="destructive">{message(mutation.error)}</Alert>}
          <Field id="security-password" label={t("password")}>
            <Input
              id="security-password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              value={password}
              disabled={mutation.isPending}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {action !== "setup" && (
            <Field id="security-code" label={t("code")}>
              <Input
                id="security-code"
                autoComplete="one-time-code"
                required
                maxLength={64}
                value={code}
                disabled={mutation.isPending}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {t("confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
