import { useQuery } from "@tanstack/react-query";
import { FolderIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import { EmptyState, ErrorState, PageLoader } from "../../components/states";
import { LAST_PROJECT_STORAGE_KEY } from "../../constants/storage";
import { useApi } from "../../lib/api-context";
import { queryKeys } from "../../lib/query-keys";
import { AppShell } from "./app-shell";

function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `/`: opens the last used project the user can still access, else the first. */
export function HomeRedirect() {
  const { t } = useTranslation();
  const api = useApi();
  const projects = useQuery({ queryKey: queryKeys.projects, queryFn: api.listProjects });

  if (projects.isPending) return <PageLoader className="min-h-dvh" />;
  if (projects.isError)
    return (
      <ErrorState className="min-h-dvh justify-center" error={projects.error} onRetry={() => projects.refetch()} />
    );
  const remembered = lastProject();
  const target = projects.data.find((p) => p.id === remembered) ?? projects.data[0];
  if (target) return <Navigate to={`/projects/${encodeURIComponent(target.id)}/issues`} replace />;
  return (
    <AppShell projects={[]} current={undefined}>
      <EmptyState icon={<FolderIcon />} title={t("projects.noneTitle")} body={t("projects.noneBody")} />
    </AppShell>
  );
}
