import { BugIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import { Logo } from "../../components/logo";
import { cn } from "../../lib/utils";
import type { Project } from "../../types/api";
import { ThemeToggle } from "../theme/theme-toggle";
import { AccountMenu } from "./account-menu";
import { ProjectSwitcher } from "./project-switcher";

function NavItem({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4",
          isActive && "bg-muted text-foreground",
        )
      }
    >
      {icon}
      {children}
    </NavLink>
  );
}

export function AppShell({
  projects,
  current,
  children,
}: {
  projects: Project[];
  current: Project | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const base = current && `/projects/${encodeURIComponent(current.id)}`;
  return (
    <div className="flex min-h-dvh flex-col bg-sidebar lg:flex-row">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:absolute focus:start-2 focus:top-2"
      >
        {t("skipToContent")}
      </a>
      <aside className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3 lg:sticky lg:top-0 lg:h-dvh lg:w-64 lg:flex-col lg:flex-nowrap lg:items-stretch lg:gap-4 lg:border-e lg:border-b-0 lg:p-4">
        <div className="flex items-center justify-between px-1">
          <Logo />
        </div>
        <div className="w-56 lg:w-auto">
          <ProjectSwitcher projects={projects} current={current} />
        </div>
        {base && (
          <nav aria-label={t("nav.main")} className="flex gap-1 lg:flex-col">
            <NavItem to={`${base}/issues`} icon={<BugIcon aria-hidden="true" />}>
              {t("nav.issues")}
            </NavItem>
            <NavItem to={`${base}/settings`} icon={<SettingsIcon aria-hidden="true" />}>
              {t("nav.settings")}
            </NavItem>
          </nav>
        )}
        <div className="ms-auto flex max-w-72 items-center gap-2 lg:ms-0 lg:mt-auto lg:max-w-none lg:border-t lg:border-border lg:pt-4">
          <AccountMenu />
          <ThemeToggle />
        </div>
      </aside>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 bg-background focus:outline-none">
        {children}
      </main>
    </div>
  );
}
