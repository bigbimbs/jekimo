import { ChevronDownIcon, XIcon } from "lucide-react";
import { ToggleGroup } from "radix-ui";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { ALL, EVENT_KINDS, ISSUE_PERIODS, ISSUE_STATUSES, SEVERITIES } from "../../constants/issues";
import { cn } from "../../lib/utils";
import type { IssueFilters as Filters } from "../../types/issues";
import { DEFAULT_FILTERS } from "./filters";

const STATUS_OPTIONS = [...ISSUE_STATUSES, ALL] as const;

export function IssueFilters({ filters, onChange }: { filters: Filters; onChange(filters: Filters): void }) {
  const { t } = useTranslation("issues");
  const set = <K extends keyof Filters>(name: K, value: string) => onChange({ ...filters, [name]: value });
  const isDefault = (Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]).every((k) => filters[k] === DEFAULT_FILTERS[k]);

  const field = (id: keyof Filters, label: string, options: [string, string][]) => {
    const changed = filters[id] !== DEFAULT_FILTERS[id];
    return (
      <div
        className={cn(
          "relative flex h-8 items-center rounded-md border border-input bg-background shadow-xs transition-[border-color,box-shadow,background-color] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25 hover:border-muted-foreground",
          changed && "bg-muted/60",
        )}
      >
        <label htmlFor={`filter-${id}`} className="shrink-0 ps-2.5 pe-1 text-xs text-muted-foreground">
          {label}
        </label>
        <select
          id={`filter-${id}`}
          value={filters[id]}
          onChange={(e) => set(id, e.target.value)}
          className="h-full min-w-0 cursor-pointer appearance-none rounded-e-md bg-transparent pe-7 ps-1 text-[0.8125rem] font-medium focus:outline-none focus-visible:outline-none"
        >
          {options.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
        <ChevronDownIcon
          aria-hidden="true"
          className="pointer-events-none absolute end-2 size-3.5 text-muted-foreground"
        />
      </div>
    );
  };

  return (
    <fieldset className="flex flex-wrap items-center gap-2">
      <legend className="sr-only">{t("filters.label")}</legend>
      <ToggleGroup.Root
        type="single"
        value={filters.status}
        onValueChange={(value) => {
          const next = STATUS_OPTIONS.find((s) => s === value);
          if (next) set("status", next);
        }}
        aria-label={t("filters.status")}
        className="inline-flex h-8 items-center gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5 me-1"
      >
        {STATUS_OPTIONS.map((s) => (
          <ToggleGroup.Item
            key={s}
            value={s}
            className="inline-flex h-full items-center rounded-md px-2.5 text-[0.8125rem] font-medium text-muted-foreground transition-[color,background-color,box-shadow] duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs data-[state=on]:ring-1 data-[state=on]:ring-border"
          >
            {t(`status.${s}`)}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
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
        <Button variant="ghost" size="sm" className="animate-fade-in" onClick={() => onChange(DEFAULT_FILTERS)}>
          <XIcon aria-hidden="true" />
          {t("filters.clear")}
        </Button>
      )}
    </fieldset>
  );
}
