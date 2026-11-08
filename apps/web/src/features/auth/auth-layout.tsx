import type { ReactNode } from "react";
import { Logo } from "../../components/logo";
import { ThemeToggle } from "../theme/theme-toggle";

export function AuthLayout({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-sidebar">
      <header className="flex items-center justify-between px-6 py-4">
        <Logo />
        <ThemeToggle />
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-16 pt-[8vh]">
        <div className="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-sm sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {intro && <p className="mt-1.5 text-sm text-muted-foreground">{intro}</p>}
          <div className="mt-6">{children}</div>
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
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
