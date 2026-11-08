import type { EventKind, Severity } from "@jekimo/event-schema";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import type { IssueStatus } from "../../constants/issues";

const SEVERITY_DOT: Record<Severity, string> = {
  debug: "bg-severity-debug",
  info: "bg-severity-info",
  warning: "bg-severity-warning",
  error: "bg-severity-error",
  fatal: "bg-severity-fatal",
};

const STATUS_DOT: Record<IssueStatus, string> = {
  unresolved: "bg-primary",
  resolved: "bg-success",
  ignored: "bg-muted-foreground",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const { t } = useTranslation("issues");
  return <Badge dot={SEVERITY_DOT[severity]}>{t(`severity.${severity}`)}</Badge>;
}

export function StatusBadge({ status }: { status: IssueStatus }) {
  const { t } = useTranslation("issues");
  return <Badge dot={STATUS_DOT[status]}>{t(`status.${status}`)}</Badge>;
}

export function KindBadge({ kind }: { kind: EventKind }) {
  const { t } = useTranslation("issues");
  return <Badge className="bg-muted text-muted-foreground">{t(`kind.${kind}`)}</Badge>;
}
