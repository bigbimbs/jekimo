import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { ErrorState, PageLoader } from "../../components/states";
import { useApi } from "../../lib/api-context";
import { isApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query-keys";
import { SessionContext } from "./session";

function SignedOut() {
  const api = useApi();
  const location = useLocation();
  const setup = useQuery({ queryKey: queryKeys.setup, queryFn: api.setupRequired, retry: false });
  if (setup.isPending) return <PageLoader className="min-h-dvh" />;
  if (setup.data) return <Navigate to="/setup" replace />;
  const next = location.pathname === "/" ? "" : `?next=${encodeURIComponent(location.pathname + location.search)}`;
  return <Navigate to={`/sign-in${next}`} replace />;
}

/** Route element for every signed-in page. */
export function RequireSession() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const session = useQuery({ queryKey: queryKeys.session, queryFn: api.getSession, retry: false, staleTime: Infinity });

  const value = useMemo(
    () =>
      session.data && {
        user: session.data.user,
        async signOut() {
          await api.logout().catch(() => undefined);
          queryClient.clear();
          navigate("/sign-in", { replace: true });
        },
      },
    [session.data, api, queryClient, navigate],
  );

  if (session.isPending) return <PageLoader className="min-h-dvh" />;
  if (isApiError(session.error, 401)) return <SignedOut />;
  if (!value)
    return <ErrorState className="min-h-dvh justify-center" error={session.error} onRetry={() => session.refetch()} />;
  return (
    <SessionContext.Provider value={value}>
      <Outlet />
    </SessionContext.Provider>
  );
}
