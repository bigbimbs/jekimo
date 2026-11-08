import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { createMemoryRouter, type RouteObject, RouterProvider } from "react-router";
import { vi } from "vitest";
import { SessionContext } from "../features/auth/session";
import { ThemeProvider } from "../features/theme/theme-provider";
import { ApiContext } from "../lib/api-context";
import { createI18n } from "../lib/i18n";
import type { Api, Project, User } from "../types/api";

export const ADMIN: User = {
  id: "u-admin",
  email: "admin@example.test",
  instance_role: "admin",
  created_at: "2026-11-01T00:00:00.000Z",
};

export const MEMBER: User = { ...ADMIN, id: "u-member", email: "member@example.test", instance_role: "member" };

export function project(id: string, name = `Project ${id}`): Project {
  return { id, name, retention_days: 30, sample_rate: 1, disabled: false, created_at: "2026-11-01T00:00:00.000Z" };
}

/** An Api whose every method rejects until a test overrides it. */
export function fakeApi(overrides: Partial<Api> = {}): Api {
  const api = new Proxy({} as Record<string, unknown>, {
    get: (target, name: string) => {
      if (!(name in target)) target[name] = vi.fn().mockRejectedValue(new Error(`unexpected call to ${name}`));
      return target[name];
    },
  });
  Object.assign(api, overrides);
  return api as unknown as Api;
}

/** Renders routes (or one element at "/") with every provider the app uses. */
export function renderApp(
  ui: ReactElement | RouteObject[],
  { api = fakeApi(), user = ADMIN, path = "/" }: { api?: Api; user?: User | null; path?: string } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const routes = Array.isArray(ui) ? ui : [{ path: "/", element: ui }];
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const session = user && { user, signOut: vi.fn() };
  const tree = <RouterProvider router={router} />;
  const result = render(
    <I18nextProvider i18n={createI18n(["en"])}>
      <ThemeProvider>
        <ApiContext.Provider value={api}>
          <QueryClientProvider client={queryClient}>
            {session ? <SessionContext.Provider value={session}>{tree}</SessionContext.Provider> : tree}
          </QueryClientProvider>
        </ApiContext.Provider>
      </ThemeProvider>
    </I18nextProvider>,
  );
  return { ...result, queryClient, router };
}
