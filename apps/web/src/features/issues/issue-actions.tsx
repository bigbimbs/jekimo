import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, EyeOffIcon, RotateCcwIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { ACTIONS_FOR_STATUS, type IssueAction } from "../../constants/issues";
import { useApi } from "../../lib/api-context";
import { useErrorMessage } from "../../lib/errors";
import { queryKeys } from "../../lib/query-keys";
import type { Issue, IssueDetail } from "../../types/api";
import { useProjectPermissions } from "../projects/permissions";

const ICONS = { resolve: CheckIcon, ignore: EyeOffIcon, reopen: RotateCcwIcon } as const;

/** Resolve, ignore, and reopen, shown only to users with `issues.manage` (docs/access-model.md). */
export function IssueActions({ projectId, issue }: { projectId: string; issue: Issue }) {
  const { t } = useTranslation("issues");
  const api = useApi();
  const queryClient = useQueryClient();
  const message = useErrorMessage();
  const { permissions } = useProjectPermissions(projectId);

  const change = useMutation({
    mutationFn: (action: IssueAction) => api.changeIssueStatus(projectId, issue.id, action),
    onSuccess: (updated) => {
      queryClient.setQueryData<IssueDetail>(queryKeys.issue(projectId, issue.id), (old) =>
        old ? { ...old, issue: updated } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues(projectId) });
    },
  });

  if (!permissions.has("issues.manage")) return null;

  return (
    <div className="grid justify-items-end gap-2">
      <fieldset className="flex gap-2">
        <legend className="sr-only">{t("actions.label")}</legend>
        {ACTIONS_FOR_STATUS[issue.status].map((action, i) => {
          const Icon = ICONS[action];
          return (
            <Button
              key={action}
              variant={i === 0 ? "default" : "outline"}
              size="sm"
              disabled={change.isPending}
              onClick={() => change.mutate(action)}
            >
              <Icon aria-hidden="true" />
              {t(`actions.${action}`)}
            </Button>
          );
        })}
      </fieldset>
      {change.isError && (
        <p role="alert" className="text-sm text-destructive">
          {message(change.error)}
        </p>
      )}
    </div>
  );
}
