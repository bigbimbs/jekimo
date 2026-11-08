import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../../components/states";
import { Card, CardHeader } from "../../components/ui/card";
import { useFormat } from "../../lib/format";
import { useProject } from "../projects/use-project";
import { KeysSection } from "./keys-section";

export function SettingsPage() {
  const { t } = useTranslation("settings");
  const project = useProject();
  const format = useFormat();

  const rows: [string, ReactNode][] = [
    [t("project.name"), project.name],
    [
      t("project.id"),
      <span key="id" className="font-mono text-xs">
        {project.id}
      </span>,
    ],
    [t("project.retention"), t("project.retentionDays", { days: project.retention_days })],
    [t("project.sampleRate"), format.number(project.sample_rate, { style: "percent", maximumFractionDigits: 2 })],
    [t("project.created"), format.dateTime(project.created_at)],
  ];

  return (
    <div className="mx-auto grid max-w-5xl gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader title={t("title")} description={t("intro", { project: project.name })} />
      <Card aria-labelledby="project-title">
        <CardHeader title={t("project.title")} titleId="project-title" />
        <dl className="grid gap-x-8 gap-y-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(([label, value]) => (
            <div key={label} className="grid min-w-0 gap-1">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-all text-[0.8125rem] font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <KeysSection projectId={project.id} />
    </div>
  );
}
