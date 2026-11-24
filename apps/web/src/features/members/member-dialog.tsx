import { LoaderCircleIcon } from "lucide-react";
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
import type { Role } from "../../types/api";
import type { MemberChange, MemberDialogAction } from "../../types/members";

export function MemberDialog({
  action,
  roles,
  userId,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  action: MemberDialogAction;
  roles: Role[];
  userId: string;
  pending: boolean;
  error: unknown;
  onClose(): void;
  onSubmit(change: MemberChange): void;
}) {
  const { t } = useTranslation("members");
  const { t: tc } = useTranslation();
  const message = useErrorMessage();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(
    action.kind === "edit"
      ? (roles.find((r) => r.name.toLowerCase() === action.member.role.toLowerCase())?.name ?? "")
      : "",
  );
  const self = action.kind !== "add" && action.member.user_id === userId;
  const title =
    action.kind === "add" ? t("dialog.addTitle") : t(`dialog.${action.kind}Title`, { email: action.member.email });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (action.kind === "remove") onSubmit({ kind: "remove", userId: action.member.user_id });
    else if (roles.some((r) => r.name === role)) {
      if (action.kind === "add" && email.trim()) onSubmit({ kind: "add", email: email.trim(), role });
      else if (action.kind === "edit") onSubmit({ kind: "edit", userId: action.member.user_id, role });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent closeLabel={tc("actions.close")}>
        <form className="grid gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{t(`dialog.${action.kind}Body`)}</DialogDescription>
          </DialogHeader>
          {self && <Alert>{t(action.kind === "remove" ? "dialog.selfRemove" : "dialog.selfEdit")}</Alert>}
          {error != null && <Alert variant="destructive">{message(error)}</Alert>}
          {action.kind === "add" && (
            <div className="grid gap-1.5">
              <label htmlFor="member-email" className="text-[0.8125rem] font-medium">
                {t("email")}
              </label>
              <Input
                id="member-email"
                type="email"
                autoComplete="off"
                required
                value={email}
                disabled={pending}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          )}
          {action.kind !== "remove" && (
            <div className="grid gap-1.5">
              <label htmlFor="member-role" className="text-[0.8125rem] font-medium">
                {t("role")}
              </label>
              <select
                id="member-role"
                required
                value={role}
                disabled={pending}
                onChange={(e) => setRole(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <option value="" disabled>
                  {t("dialog.chooseRole")}
                </option>
                {roles.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
              {roles.find((r) => r.name === role)?.description && (
                <p className="text-xs text-muted-foreground">{roles.find((r) => r.name === role)?.description}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {tc("actions.cancel")}
            </Button>
            <Button
              type="submit"
              variant={action.kind === "remove" ? "destructive" : "default"}
              disabled={
                pending ||
                (action.kind !== "remove" && !roles.some((r) => r.name === role)) ||
                (action.kind === "edit" && role.toLowerCase() === action.member.role.toLowerCase()) ||
                (action.kind === "add" && !email.trim())
              }
            >
              {pending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
              {t(action.kind === "add" ? "add" : action.kind === "edit" ? "dialog.save" : "dialog.remove")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
