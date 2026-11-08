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
import type { Project } from "../../types/api";

export function ProjectSwitcher({ projects, current }: { projects: Project[]; current: Project | undefined }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-start text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={current ? t("projectSwitcher.current", { name: current.name }) : t("projectSwitcher.label")}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-muted-foreground">{t("projectSwitcher.label")}</span>
          <span className="block truncate font-medium">{current?.name ?? t("projectSwitcher.choose")}</span>
        </span>
        <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) max-h-80 overflow-y-auto">
        <DropdownMenuLabel>{t("projectSwitcher.switch")}</DropdownMenuLabel>
        {projects.map((p) => (
          <DropdownMenuItem
            key={p.id}
            onSelect={() => {
              if (p.id !== current?.id) navigate(`/projects/${encodeURIComponent(p.id)}/issues`);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {p.id === current?.id && <CheckIcon className="text-primary" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
