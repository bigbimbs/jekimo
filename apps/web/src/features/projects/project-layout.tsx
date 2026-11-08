import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderXIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useParams } from "react-router";
import { EmptyState, ErrorState, PageLoader } from "../../components/states";
import { Button } from "../../components/ui/button";
import { LAST_PROJECT_STORAGE_KEY } from "../../constants/storage";
import { useApi } from "../../lib/api-context";
import { queryKeys } from "../../lib/query-keys";
import type { ProjectOutlet } from "../../types/projects";
import { AppShell } from "./app-shell";

export function ProjectLayout() {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const { projectId = "" } = useParams();
  const projects = useQuery({ queryKey: queryKeys.projects, queryFn: api.listProjects });
  const project = projects.data?.find((p) => p.id === projectId);

  // Leaving a project drops everything cached for it, so no screen of the
  // next project can render the previous one's data, even for a frame.
  useEffect(
    () => () => queryClient.removeQueries({ queryKey: queryKeys.project(projectId) }),
    [projectId, queryClient],
  );

  useEffect(() => {
    if (!project) return;
    try {
      localStorage.setItem(LAST_PROJECT_STORAGE_KEY, project.id);
    } catch {
      // Remembering the last project is a convenience only.
    }
  }, [project]);

  let content: ReactNode;
  if (projects.isPending) content = <PageLoader />;
  else if (projects.isError) content = <ErrorState error={projects.error} onRetry={() => projects.refetch()} />;
  else if (!project)
    content = (
      <EmptyState
        icon={<FolderXIcon />}
        title={t("projects.notFoundTitle")}
        body={t("projects.notFoundBody")}
        action={
          <Button asChild variant="outline">
            <Link to="/">{t("states.goHome")}</Link>
          </Button>
        }
      />
    );
  else content = <Outlet key={project.id} context={{ project } satisfies ProjectOutlet} />;

  return (
    <AppShell projects={projects.data ?? []} current={project}>
      {content}
    </AppShell>
  );
}
