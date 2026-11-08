import type { EventKind, Severity } from "@jekimo/event-schema";
import { ActivityIcon, CheckIcon, CircleDotIcon, EyeOffIcon, ScrollTextIcon, ZapIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import type { IssueStatus } from "../../constants/issues";

const SEVERITY_STYLE: Record<Severity, { dot: string; tint: string }> = {
  debug: { dot: "bg-severity-debug", tint: "border-severity-debug/30 bg-severity-debug/10" },
  info: { dot: "bg-severity-info", tint: "border-severity-info/30 bg-severity-info/10" },
  warning: { dot: "bg-severity-warning", tint: "border-severity-warning/30 bg-severity-warning/10" },
  error: { dot: "bg-severity-error", tint: "border-severity-error/30 bg-severity-error/10" },
  fatal: { dot: "bg-severity-fatal", tint: "border-severity-fatal/30 bg-severity-fatal/10" },
};

const STATUS_STYLE: Record<IssueStatus, { icon: ReactNode; tint: string }> = {
  unresolved: { icon: <CircleDotIcon aria-hidden="true" className="text-muted-foreground" />, tint: "bg-background" },
  resolved: {
    icon: <CheckIcon aria-hidden="true" className="text-success" />,
    tint: "border-success/30 bg-success/10",
  },
  ignored: { icon: <EyeOffIcon aria-hidden="true" className="text-muted-foreground" />, tint: "bg-muted" },
};

const KIND_ICONS = { exception: ZapIcon, log: ScrollTextIcon, event: ActivityIcon } as const;

function KindIcon({ kind }: { kind: EventKind }) {
  const Icon = KIND_ICONS[kind];
  return <Icon aria-hidden="true" />;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const { t } = useTranslation("issues");
  const style = SEVERITY_STYLE[severity];
  return (
    <Badge dot={style.dot} className={style.tint}>
      {t(`severity.${severity}`)}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: IssueStatus }) {
  const { t } = useTranslation("issues");
  const style = STATUS_STYLE[status];
  return (
    <Badge icon={style.icon} className={style.tint}>
      {t(`status.${status}`)}
    </Badge>
  );
}

export function KindBadge({ kind }: { kind: EventKind }) {
  const { t } = useTranslation("issues");
  return (
    <Badge icon={<KindIcon kind={kind} />} className="border-transparent bg-muted text-muted-foreground">
      {t(`kind.${kind}`)}
    </Badge>
  );
}
