import type { ReactNode } from "react";
import { Logo } from "../../components/logo";
import { ThemeToggle } from "../theme/theme-toggle";

export function AuthLayout({
  title,
  intro,
  icon,
  wide,
  children,
}: {
  title: string;
  intro?: string;
  icon?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-sidebar">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-size-[20px_20px] mask-[radial-gradient(ellipse_70%_60%_at_50%_0%,black_30%,transparent_100%)]"
      />
      <header className="flex items-center justify-between px-5 py-4 sm:px-8">
        <Logo />
        <ThemeToggle />
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-16 pt-[6vh] sm:pt-[10vh]">
        <div className={wide ? "w-full max-w-md" : "w-full max-w-[25rem]"}>
          <div className="rounded-xl border border-border bg-background p-6 shadow-xl shadow-black/[0.04] animate-dialog-in sm:p-8 dark:shadow-black/40">
            {icon && (
              <div className="mb-5 flex size-10 items-center justify-center rounded-lg border border-border bg-sidebar text-muted-foreground shadow-xs [&_svg]:size-5">
                {icon}
              </div>
            )}
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {intro && <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{intro}</p>}
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </main>
    </div>
  );
}

export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[0.8125rem] font-medium">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
