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
          "group relative flex h-8 items-center gap-2 rounded-md px-2.5 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
          "max-lg:h-12 max-lg:rounded-none max-lg:px-1 max-lg:hover:bg-transparent",
          "after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full lg:after:hidden",
          isActive &&
            "text-foreground after:bg-primary lg:bg-background lg:shadow-xs lg:ring-1 lg:ring-border [&_svg]:text-primary",
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
        className="sr-only z-50 rounded-md bg-background px-3 py-2 shadow-md focus:not-sr-only focus:fixed focus:start-2 focus:top-2"
      >
        {t("skipToContent")}
      </a>
      <aside className="sticky top-0 z-30 flex shrink-0 flex-wrap items-center gap-x-4 border-b border-border bg-sidebar/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-sidebar/80 lg:h-dvh lg:w-60 lg:flex-col lg:flex-nowrap lg:items-stretch lg:gap-0 lg:border-e lg:border-b-0 lg:bg-sidebar lg:p-3 lg:backdrop-blur-none">
        <div className="flex h-12 items-center lg:h-10 lg:px-1.5">
          <Logo />
        </div>
        <div className="w-52 lg:mt-3 lg:w-auto">
          <ProjectSwitcher projects={projects} current={current} />
        </div>
        {base && (
          <nav aria-label={t("nav.main")} className="flex gap-4 lg:mt-5 lg:grid lg:gap-0.5">
            <p aria-hidden="true" className="hidden px-2.5 pb-1.5 text-xs font-medium text-muted-foreground lg:block">
              {t("nav.main")}
            </p>
            <NavItem to={`${base}/issues`} icon={<BugIcon aria-hidden="true" />}>
              {t("nav.issues")}
            </NavItem>
            <NavItem to={`${base}/settings`} icon={<SettingsIcon aria-hidden="true" />}>
              {t("nav.settings")}
            </NavItem>
          </nav>
        )}
        <div className="ms-auto flex items-center gap-2 py-2 lg:ms-0 lg:mt-auto lg:grid lg:gap-2 lg:border-t lg:border-border lg:pb-0 lg:pt-3">
          <AccountMenu />
          <ThemeToggle className="lg:w-full" />
        </div>
      </aside>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 bg-background focus:outline-none">
        {children}
      </main>
    </div>
  );
}
