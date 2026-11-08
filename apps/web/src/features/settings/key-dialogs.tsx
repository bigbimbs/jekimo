import { KeyRoundIcon, LoaderCircleIcon, RefreshCwIcon, ShieldAlertIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { useErrorMessage } from "../../lib/errors";
import { useFormat } from "../../lib/format";
import { cn } from "../../lib/utils";
import type { IssuedKey } from "../../types/api";
import { SecretKey } from "./secret-key";

function DialogIcon({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "destructive" }) {
  return (
    <div
      className={cn(
        "mb-1 flex size-9 items-center justify-center rounded-lg border shadow-xs [&_svg]:size-4.5",
        tone === "default" && "border-border bg-sidebar text-muted-foreground",
        tone === "destructive" && "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      {children}
    </div>
  );
}

/** Shows a new key once. Closing drops it: the parent clears `issued`. */
export function SecretKeyDialog({ issued, onClose }: { issued: IssuedKey | null; onClose(): void }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const format = useFormat();
  return (
    <Dialog open={issued !== null} onOpenChange={(open) => !open && onClose()}>
      {issued && (
        <DialogContent closeLabel={tc("actions.close")} onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogIcon>
              <KeyRoundIcon aria-hidden="true" />
            </DialogIcon>
            <DialogTitle>{t("secret.title")}</DialogTitle>
            <DialogDescription>
              {issued.rotated?.expires_at
                ? t("secret.oldKeyExpires", {
                    keyId: issued.rotated.key_id,
                    time: format.dateTime(issued.rotated.expires_at),
                  })
                : t("secret.intro")}
            </DialogDescription>
          </DialogHeader>
          <SecretKey issued={issued} />
          <DialogFooter>
            <DialogClose asChild>
              <Button>{t("secret.done")}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

export function CreateKeyDialog({
  open,
  onOpenChange,
  onCreate,
  pending,
  error,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreate(name: string): void;
  pending: boolean;
  error: unknown;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const message = useErrorMessage();
  const [name, setName] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    onCreate(name.trim());
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setName("");
        onOpenChange(next);
      }}
    >
      <DialogContent closeLabel={tc("actions.close")}>
        <form className="grid gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogIcon>
              <KeyRoundIcon aria-hidden="true" />
            </DialogIcon>
            <DialogTitle>{t("createDialog.title")}</DialogTitle>
            <DialogDescription>{t("createDialog.body")}</DialogDescription>
          </DialogHeader>
          {error != null && <Alert variant="destructive">{message(error)}</Alert>}
          <div className="grid gap-1.5">
            <label htmlFor="key-name" className="text-[0.8125rem] font-medium">
              {t("createDialog.name")}
            </label>
            <Input
              id="key-name"
              maxLength={128}
              placeholder={t("createDialog.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{tc("actions.cancel")}</Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
              {pending ? t("createDialog.submitting") : t("createDialog.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirm,
  pending,
  error,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  body: ReactNode;
  confirm: string;
  pending: boolean;
  error: unknown;
  destructive?: boolean;
  onConfirm(): void;
}) {
  const { t: tc } = useTranslation();
  const message = useErrorMessage();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={tc("actions.close")}>
        <DialogHeader>
          <DialogIcon tone={destructive ? "destructive" : "default"}>
            {destructive ? <ShieldAlertIcon aria-hidden="true" /> : <RefreshCwIcon aria-hidden="true" />}
          </DialogIcon>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        {error != null && <Alert variant="destructive">{message(error)}</Alert>}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{tc("actions.cancel")}</Button>
          </DialogClose>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending} onClick={onConfirm}>
            {pending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
