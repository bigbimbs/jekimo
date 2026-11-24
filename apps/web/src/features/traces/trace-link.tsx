import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { TRACE_ID_PATTERN } from "../../constants/tracing";
export function TraceLink({
  projectId,
  traceId,
  receivedAt,
}: {
  projectId: string;
  traceId: string | undefined;
  receivedAt: string;
}) {
  const { t } = useTranslation("traces");
  if (!traceId || !TRACE_ID_PATTERN.test(traceId)) return null;
  const at = Date.parse(receivedAt);
  if (!Number.isFinite(at)) return null;
  const query = new URLSearchParams({
    from: new Date(at - 86400000).toISOString(),
    to: new Date(at + 86400000).toISOString(),
  });
  return (
    <Link
      className="text-sm text-primary underline-offset-4 hover:underline"
      to={`/projects/${encodeURIComponent(projectId)}/traces/${traceId}?${query}`}
    >
      {t("view")}
    </Link>
  );
}
