import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
    <div className="mx-auto grid max-w-5xl gap-10 p-6 lg:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <section className="grid gap-4" aria-labelledby="project-title">
        <h2 id="project-title" className="text-base font-semibold">
          {t("project.title")}
        </h2>
        <dl className="grid gap-x-6 gap-y-4 rounded-lg border border-border p-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(([label, value]) => (
            <div key={label} className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-all text-sm">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <KeysSection projectId={project.id} />
    </div>
  );
}
