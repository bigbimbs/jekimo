import { CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import type { IssuedKey } from "../../types/api";

/**
 * The full ingestion key, shown once (docs/ingestion-protocol.md,
 * "Authentication", Rules). Callers keep the key in component state only and
 * drop it when this unmounts; it never enters the query cache.
 */
export function SecretKey({ issued }: { issued: IssuedKey }) {
  const { t } = useTranslation("settings");
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(issued.key);
      setCopy("copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopy("idle"), 2000);
    } catch {
      setCopy("failed");
      input.current?.select();
    }
  }

  return (
    <div className="grid gap-3">
      <Alert variant="warning">
        <TriangleAlertIcon aria-hidden="true" />
        <p>{t("secret.warning")}</p>
      </Alert>
      <div className="grid gap-1.5">
        <label htmlFor="secret-key" className="text-sm font-medium">
          {t("secret.label", { keyId: issued.key_id })}
        </label>
        <div className="flex gap-2">
          <Input
            ref={input}
            id="secret-key"
            readOnly
            value={issued.key}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button variant="outline" onClick={copyKey} aria-live="polite">
            {copy === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            {copy === "copied" ? t("secret.copied") : t("secret.copy")}
          </Button>
        </div>
        {copy === "failed" && <p className="text-xs text-destructive">{t("secret.copyFailed")}</p>}
      </div>
    </div>
  );
}
