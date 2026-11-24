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
import { NativeSelect } from "../../components/ui/input";
import { ApiError } from "../../lib/api-client";
import { useApi } from "../../lib/api-context";
import { useErrorMessage } from "../../lib/errors";
import type { IssuedAccountLink, UserAction } from "../../types/admin";
import type { AccountUser } from "../../types/api";
import { useSession } from "../auth/session";

export function UserActionDialog({
  action,
  lastAdmin,
  onClose,
  onChanged,
  onIssued,
}: {
  action: UserAction;
  lastAdmin: boolean;
  onClose(): void;
  onChanged(user: AccountUser): Promise<void>;
  onIssued(link: IssuedAccountLink): void;
}) {
  const { t } = useTranslation("admin");
  const api = useApi();
  const { user } = useSession();
  const message = useErrorMessage();
  const [role, setRole] = useState(action.user.instance_role);
  const blocked = lastAdmin && (action.kind === "deactivate" || (action.kind === "role" && role !== "admin"));
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      if (action.kind === "reset") {
        const result = await api.createPasswordReset(action.user.id);
        onIssued({ kind: "reset", email: action.user.email, link: result.link, expiresAt: result.reset.expires_at });
      } else {
        const changed = await api.updateUser(
          action.user.id,
          action.kind === "role"
            ? { instance_role: role }
            : { status: action.kind === "deactivate" ? "deactivated" : "active" },
        );
        await onChanged(changed);
      }
    },
    onSuccess: onClose,
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!mutation.isPending && !blocked) mutation.mutate();
  }
  const error =
    mutation.error instanceof ApiError && mutation.error.code === "last_admin"
      ? t("lastAdmin")
      : mutation.error instanceof ApiError && mutation.error.code === "user_not_found"
        ? t("userMissing")
        : message(mutation.error);
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent closeLabel={t("close")}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t(`dialog.${action.kind}`, { email: action.user.email })}</DialogTitle>
            <DialogDescription>
              {action.kind === "role" ? t("roleHelp") : t(`dialog.${action.kind}Body`)}
            </DialogDescription>
          </DialogHeader>
          {action.kind === "role" && (
            <div className="grid gap-1.5">
              <label htmlFor="user-role" className="text-sm font-medium">
                {t("role")}
              </label>
              <NativeSelect
                id="user-role"
                value={role}
                disabled={mutation.isPending}
                onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "member")}
              >
                <option value="member">{t("roles.member")}</option>
                <option value="admin">{t("roles.admin")}</option>
              </NativeSelect>
            </div>
          )}
          {action.user.id === user.id && action.kind === "deactivate" && (
            <Alert variant="warning">{t("dialog.selfDeactivate")}</Alert>
          )}
          {action.user.id === user.id && action.kind === "role" && role === "member" && (
            <Alert variant="warning">{t("dialog.selfRole")}</Alert>
          )}
          {blocked && <Alert variant="warning">{t("lastAdmin")}</Alert>}
          {mutation.error && <Alert variant="destructive">{error}</Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              variant={action.kind === "deactivate" ? "destructive" : "default"}
              disabled={mutation.isPending || blocked || (action.kind === "role" && role === action.user.instance_role)}
            >
              {t(action.kind === "role" ? "save" : action.kind)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
