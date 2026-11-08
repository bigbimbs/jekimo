import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { NativeSelect } from "../../components/ui/input";
import { ALL, EVENT_KINDS, ISSUE_PERIODS, ISSUE_STATUSES, SEVERITIES } from "../../constants/issues";
import type { IssueFilters as Filters } from "../../types/issues";
import { DEFAULT_FILTERS } from "./filters";

export function IssueFilters({ filters, onChange }: { filters: Filters; onChange(filters: Filters): void }) {
  const { t } = useTranslation("issues");
  const set = <K extends keyof Filters>(name: K, value: string) => onChange({ ...filters, [name]: value });
  const isDefault = (Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]).every((k) => filters[k] === DEFAULT_FILTERS[k]);

  const field = (id: keyof Filters, label: string, options: [string, string][]) => (
    <div className="grid gap-1">
      <label htmlFor={`filter-${id}`} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <NativeSelect id={`filter-${id}`} value={filters[id]} onChange={(e) => set(id, e.target.value)}>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </NativeSelect>
    </div>
  );

  return (
    <fieldset className="flex flex-wrap items-end gap-3">
      <legend className="sr-only">{t("filters.label")}</legend>
      {field("status", t("filters.status"), [
        ...ISSUE_STATUSES.map((s): [string, string] => [s, t(`status.${s}`)]),
        [ALL, t("status.all")],
      ])}
      {field("kind", t("filters.kind"), [
        [ALL, t("filters.any")],
        ...EVENT_KINDS.map((k): [string, string] => [k, t(`kind.${k}`)]),
      ])}
      {field("severity", t("filters.severity"), [
        [ALL, t("filters.any")],
        ...SEVERITIES.map((s): [string, string] => [s, t(`severity.${s}`)]),
      ])}
      {field(
        "period",
        t("filters.period"),
        (Object.keys(ISSUE_PERIODS) as (keyof typeof ISSUE_PERIODS)[]).map((p): [string, string] => [
          p,
          t(`period.${p}`),
        ]),
      )}
      {!isDefault && (
        <Button variant="ghost" size="sm" className="mb-0.5" onClick={() => onChange(DEFAULT_FILTERS)}>
          {t("filters.clear")}
        </Button>
      )}
    </fieldset>
  );
}
