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
import { Input, NativeSelect } from "../../components/ui/input";
import { useApi } from "../../lib/api-context";
import { useErrorMessage } from "../../lib/errors";
import type { IssuedAccountLink } from "../../types/admin";
import type { Invitation, User } from "../../types/api";

export function InviteDialog({ onClose, onIssued }: { onClose(): void; onIssued(link: IssuedAccountLink): void }) {
  const { t } = useTranslation("admin");
  const api = useApi();
  const message = useErrorMessage();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<User["instance_role"]>("member");
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      const result = await api.createInvitation(email.trim(), role);
      onIssued({
        kind: "invite",
        email: result.invitation.email,
        link: result.link,
        expiresAt: result.invitation.expires_at,
      });
    },
    onSuccess: onClose,
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!mutation.isPending && email.trim()) mutation.mutate();
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent closeLabel={t("close")}>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t("invite")}</DialogTitle>
            <DialogDescription>{t("dialog.inviteBody")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor="invite-email" className="text-sm font-medium">
              {t("email")}
            </label>
            <Input
              id="invite-email"
              type="email"
              autoComplete="off"
              maxLength={254}
              required
              value={email}
              disabled={mutation.isPending}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="invite-role" className="text-sm font-medium">
              {t("role")}
            </label>
            <NativeSelect
              id="invite-role"
              value={role}
              disabled={mutation.isPending}
              onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "member")}
            >
              <option value="member">{t("roles.member")}</option>
              <option value="admin">{t("roles.admin")}</option>
            </NativeSelect>
            <p className="text-xs text-muted-foreground">{t("roleHelp")}</p>
          </div>
          {mutation.error && <Alert variant="destructive">{message(mutation.error)}</Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={mutation.isPending || !email.trim()}>
              {t("invite")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RevokeInvitationDialog({
  invitation,
  onClose,
  onRevoked,
}: {
  invitation: Invitation;
  onClose(): void;
  onRevoked(): Promise<void>;
}) {
  const { t } = useTranslation("admin");
  const api = useApi();
  const message = useErrorMessage();
  const mutation = useMutation({
    mutationFn: () => api.revokeInvitation(invitation.id),
    onSuccess: async () => {
      await onRevoked();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent closeLabel={t("close")}>
        <DialogHeader>
          <DialogTitle>{t("dialog.revokeTitle", { email: invitation.email })}</DialogTitle>
          <DialogDescription>{t("dialog.revokeBody")}</DialogDescription>
        </DialogHeader>
        {mutation.error && <Alert variant="destructive">{message(mutation.error)}</Alert>}
        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {t("revoke")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
