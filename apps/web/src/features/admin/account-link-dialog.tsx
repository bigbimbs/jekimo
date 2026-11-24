import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, useState } from "react";
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
import { useFormat } from "../../lib/format";
import type { IssuedAccountLink } from "../../types/admin";

export function AccountLinkDialog({ issued, onClose }: { issued: IssuedAccountLink; onClose(): void }) {
  const { t } = useTranslation("admin");
  const format = useFormat();
  const input = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const link = new URL(issued.link, window.location.origin).href;
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopy("copied");
    } catch {
      setCopy("failed");
      input.current?.select();
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={t("close")}>
        <DialogHeader>
          <DialogTitle>{t(issued.kind === "invite" ? "link.inviteTitle" : "link.resetTitle")}</DialogTitle>
          <DialogDescription>{t("link.for", { email: issued.email })}</DialogDescription>
        </DialogHeader>
        <Alert variant="warning">{t("link.warning")}</Alert>
        <div className="grid gap-2">
          <label htmlFor="account-link" className="text-sm font-medium">
            {t("link.label")}
          </label>
          <Input
            id="account-link"
            ref={input}
            value={link}
            readOnly
            autoComplete="off"
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-xs"
          />
          <Button variant="outline" onClick={copyLink}>
            {copy === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            {t(copy === "copied" ? "link.copied" : "link.copy")}
          </Button>
          {copy === "failed" && (
            <p role="alert" className="text-xs text-destructive">
              {t("link.copyFailed")}
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("link.expires", { time: format.dateTime(issued.expiresAt) })}
        </p>
        <DialogFooter>
          <Button onClick={onClose}>{t("link.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
