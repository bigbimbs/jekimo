import { useMutation } from "@tanstack/react-query";
import QRCode from "qrcode";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useErrorMessage } from "../../lib/errors";
import type { TwoFactorSetup } from "../../types/api";
import { Field } from "../auth/auth-layout";

export function AuthenticatorSetup({
  setup,
  onVerify,
  onCancel,
}: {
  setup: TwoFactorSetup;
  onVerify(code: string): Promise<void>;
  onCancel(): void;
}) {
  const { t } = useTranslation("security");
  const message = useErrorMessage();
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(setup.otpauth_uri, { width: 224, margin: 2 })
      .then((data) => {
        if (active) setQr(data);
      })
      .catch(() => {
        if (active) setQr("");
      });
    return () => {
      active = false;
    };
  }, [setup.otpauth_uri]);
  const mutation = useMutation({ gcTime: 0, mutationFn: () => onVerify(code.trim()) });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!mutation.isPending) mutation.mutate();
  }
  return (
    <form className="grid gap-4" onSubmit={submit}>
      <h2 className="font-semibold">{t("setupTitle")}</h2>
      <p className="text-sm text-muted-foreground">{t("setupIntro")}</p>
      {qr && <img src={qr} width={224} height={224} alt={t("qrAlt")} className="rounded-lg" />}
      <Field id="authenticator-secret" label={t("secret")}>
        <Input id="authenticator-secret" readOnly value={setup.secret} className="font-mono" />
      </Field>
      {mutation.error && <Alert variant="destructive">{message(mutation.error)}</Alert>}
      <Field id="authenticator-code" label={t("totpCode")}>
        <Input
          id="authenticator-code"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          required
          maxLength={6}
          value={code}
          disabled={mutation.isPending}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {t("verify")}
        </Button>
        <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onCancel}>
          {t("restart")}
        </Button>
      </div>
    </form>
  );
}
