import { useTranslation } from "react-i18next";
import { Input } from "../../components/ui/input";
import { PASSWORD_MAX_CHARS, PASSWORD_MIN_CHARS } from "../../constants/passwords";
import { Field } from "./auth-layout";

export function PasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  label,
}: {
  password: string;
  confirm: string;
  onPassword(value: string): void;
  onConfirm(value: string): void;
  label?: string;
}) {
  const { t } = useTranslation("auth");
  const limits = { min: PASSWORD_MIN_CHARS, max: PASSWORD_MAX_CHARS };
  return (
    <>
      <Field id="new-password" label={label ?? t("password.new")} hint={t("password.hint", limits)}>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_CHARS}
          maxLength={PASSWORD_MAX_CHARS}
          aria-describedby="new-password-hint"
          value={password}
          onChange={(e) => onPassword(e.target.value)}
        />
      </Field>
      <Field id="confirm-password" label={t("password.confirm")}>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => onConfirm(e.target.value)}
        />
      </Field>
    </>
  );
}
