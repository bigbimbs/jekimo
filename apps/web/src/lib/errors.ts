import { useTranslation } from "react-i18next";
import { KNOWN_ERROR_CODES, type KnownErrorCode } from "../constants/api";
import { ApiError } from "./api-client";

function isKnown(code: string): code is KnownErrorCode {
  return (KNOWN_ERROR_CODES as readonly string[]).includes(code);
}

/** Text for an API error from its stable code; the API's English message only for codes the catalogue lacks. */
export function useErrorMessage(): (error: unknown) => string {
  const { t } = useTranslation("errors");
  return (error) => {
    if (error instanceof ApiError) {
      if (isKnown(error.code)) return t(error.code);
      if (error.message) return error.message;
    }
    return t("unknown");
  };
}

export function isApiError(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.status === status;
}
