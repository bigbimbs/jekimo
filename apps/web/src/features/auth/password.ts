import { PASSWORD_MAX_CHARS, PASSWORD_MIN_CHARS } from "../../constants/passwords";
import type { PasswordProblem } from "../../types/auth";

export function passwordProblem(password: string, confirm: string): PasswordProblem | null {
  if (password.length < PASSWORD_MIN_CHARS) return "tooShort";
  if (password.length > PASSWORD_MAX_CHARS) return "tooLong";
  if (password !== confirm) return "mismatch";
  return null;
}
