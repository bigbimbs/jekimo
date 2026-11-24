import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink } from "react-router";
import { Logo } from "../../components/logo";
import { EmptyState, PageHeader } from "../../components/states";
import { cn } from "../../lib/utils";
import { useSession } from "../auth/session";
import { AccountMenu } from "../projects/account-menu";
import { ThemeToggle } from "../theme/theme-toggle";

export function AdminShell({
  title,
  description,
  children,
  noAccess,
}: {
  title: string;
  description: string;
  children: ReactNode;
  noAccess?: string;
}) {
  const { t } = useTranslation("admin");
  const { user } = useSession();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (user.instance_role !== "admin") {
      queryClient.removeQueries({ queryKey: ["admin"] });
      return;
    }
    return () => queryClient.removeQueries({ queryKey: ["admin"] });
  }, [queryClient, user.instance_role]);
  return (
    <div className="min-h-dvh bg-sidebar">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <Logo />
        <div className="flex items-center gap-2">
          <AccountMenu />
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:py-8">
        <div className="flex flex-wrap gap-4 text-sm">
          <Link to="/" className="text-primary hover:underline">
            {t("dashboard")}
          </Link>
          <Link to="/security" className="text-primary hover:underline">
            {t("security")}
          </Link>
        </div>
        <PageHeader title={title} description={description} />
        {user.instance_role === "admin" ? (
          <>
            <nav aria-label={t("navigation")} className="flex flex-wrap gap-1 border-b border-border">
              {(["users", "invitations", "email", "audit"] as const).map((page) => (
                <NavLink
                  key={page}
                  to={`/admin/${page === "audit" ? "audit-log" : page}`}
                  className={({ isActive }) =>
                    cn(
                      "border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground",
                      isActive && "border-primary font-medium text-foreground",
                    )
                  }
                >
                  {t(page)}
                </NavLink>
              ))}
            </nav>
            {children}
          </>
        ) : (
          <EmptyState title={noAccess ?? t("noAccess")} />
        )}
      </main>
    </div>
  );
}
