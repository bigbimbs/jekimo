import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { i18n } from "i18next";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { createBrowserRouter, RouterProvider } from "react-router";
import { ThemeProvider } from "../features/theme/theme-provider";
import { ApiError, createApiClient } from "../lib/api-client";
import { ApiContext } from "../lib/api-context";
import { routes } from "./routes";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
    },
  });
}

export function App({ i18n }: { i18n: i18n }) {
  const [state] = useState(() => {
    const queryClient = createQueryClient();
    const router = createBrowserRouter(routes);
    const api = createApiClient({
      onUnauthorized: () => {
        const { pathname, search } = router.state.location;
        queryClient.clear();
        void router.navigate(`/sign-in?next=${encodeURIComponent(pathname + search)}`, { replace: true });
      },
    });
    return { queryClient, router, api };
  });

  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <ApiContext.Provider value={state.api}>
          <QueryClientProvider client={state.queryClient}>
            <RouterProvider router={state.router} />
          </QueryClientProvider>
        </ApiContext.Provider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
