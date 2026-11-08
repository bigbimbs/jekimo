import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { cn } from "../../lib/utils";
import type { Project } from "../../types/api";

function ProjectMark({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-xs font-semibold uppercase text-foreground",
        className,
      )}
    >
      {Array.from(name.trim())[0] ?? "·"}
    </span>
  );
}

export function ProjectSwitcher({ projects, current }: { projects: Project[]; current: Project | undefined }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="group flex h-10 w-full items-center gap-2.5 rounded-lg border border-border bg-background px-2 text-start text-sm shadow-xs transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted/60"
        aria-label={current ? t("projectSwitcher.current", { name: current.name }) : t("projectSwitcher.label")}
      >
        {current && <ProjectMark name={current.name} />}
        <span className="min-w-0 flex-1">
          <span className="block text-[0.6875rem] leading-tight text-muted-foreground">
            {t("projectSwitcher.label")}
          </span>
          <span className="block truncate text-[0.8125rem] font-medium leading-tight">
            {current?.name ?? t("projectSwitcher.choose")}
          </span>
        </span>
        <ChevronsUpDownIcon
          className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) max-h-80 min-w-60 overflow-y-auto"
      >
        <DropdownMenuLabel>{t("projectSwitcher.switch")}</DropdownMenuLabel>
        {projects.map((p) => (
          <DropdownMenuItem
            key={p.id}
            className={cn(p.id === current?.id && "font-medium")}
            onSelect={() => {
              if (p.id !== current?.id) navigate(`/projects/${encodeURIComponent(p.id)}/issues`);
            }}
          >
            <ProjectMark name={p.name} className="size-5 text-[0.625rem]" />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {p.id === current?.id && <CheckIcon className="text-primary!" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
