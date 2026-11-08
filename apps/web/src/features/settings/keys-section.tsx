import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, LockIcon, PlusIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState, ErrorState, PageLoader } from "../../components/states";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useApi } from "../../lib/api-context";
import { useFormat } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import { cn } from "../../lib/utils";
import type { IngestionKey, IssuedKey, KeyStatus } from "../../types/api";
import { useProjectPermissions } from "../projects/permissions";
import { ConfirmDialog, CreateKeyDialog, SecretKeyDialog } from "./key-dialogs";

const STATUS_STYLE: Record<KeyStatus, { dot: string; tint: string }> = {
  active: { dot: "bg-success", tint: "border-success/30 bg-success/10" },
  rotating: { dot: "bg-warning", tint: "border-warning/30 bg-warning/10" },
  expired: { dot: "bg-muted-foreground", tint: "bg-muted" },
  revoked: { dot: "bg-destructive", tint: "border-destructive/30 bg-destructive/10" },
};

type Pending = { action: "rotate" | "revoke"; key: IngestionKey } | null;

export function KeysSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation("settings");
  const api = useApi();
  const queryClient = useQueryClient();
  const format = useFormat();
  const { permissions, isPending: permissionsPending } = useProjectPermissions(projectId);
  const canManage = permissions.has("keys.manage");
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<Pending>(null);
  // The full key lives here and nowhere else; it is dropped when the dialog closes.
  const [issued, setIssued] = useState<IssuedKey | null>(null);

  const keys = useQuery({
    queryKey: queryKeys.keys(projectId),
    queryFn: () => api.listKeys(projectId),
    enabled: canManage,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.keys(projectId) });
  const showOnce = (key: IssuedKey) => {
    setIssued(key);
    void refresh();
  };

  const create = useMutation({
    gcTime: 0,
    mutationFn: (name: string) => api.createKey(projectId, name),
    onSuccess: (key) => {
      setCreating(false);
      create.reset();
      showOnce(key);
    },
  });
  const rotate = useMutation({
    gcTime: 0,
    mutationFn: (keyId: string) => api.rotateKey(projectId, keyId),
    onSuccess: (key) => {
      setConfirming(null);
      rotate.reset();
      showOnce(key);
    },
  });
  const revoke = useMutation({
    mutationFn: (keyId: string) => api.revokeKey(projectId, keyId),
    onSuccess: () => {
      setConfirming(null);
      void refresh();
    },
  });

  let body: ReactNode;
  if (permissionsPending) body = <PageLoader />;
  else if (!canManage) body = <EmptyState icon={<LockIcon />} title={t("keys.noPermission")} />;
  else if (keys.isPending) body = <PageLoader />;
  else if (keys.isError) body = <ErrorState error={keys.error} onRetry={() => keys.refetch()} />;
  else if (keys.data.length === 0)
    body = <EmptyState icon={<KeyRoundIcon />} title={t("keys.emptyTitle")} body={t("keys.emptyBody")} />;
  else
    body = (
      <Table>
        <caption className="sr-only">{t("keys.title")}</caption>
        <TableHeader>
          <TableRow>
            <TableHead>{t("keys.table.keyId")}</TableHead>
            <TableHead className="w-full">{t("keys.table.name")}</TableHead>
            <TableHead>{t("keys.table.status")}</TableHead>
            <TableHead>{t("keys.table.created")}</TableHead>
            <TableHead>{t("keys.table.expires")}</TableHead>
            <TableHead>
              <span className="sr-only">{t("keys.table.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <tbody>
          {keys.data.map((key) => {
            const live = key.status === "active" || key.status === "rotating";
            return (
              <TableRow key={key.key_id} className={cn("hover:bg-sidebar", !live && "text-muted-foreground")}>
                <TableCell className="whitespace-nowrap py-2.5 font-mono text-xs font-medium">{key.key_id}</TableCell>
                <TableCell className="max-w-0 truncate font-medium">
                  {key.name || <span className="text-muted-foreground">{t("keys.unnamed")}</span>}
                </TableCell>
                <TableCell>
                  <Badge dot={STATUS_STYLE[key.status].dot} className={STATUS_STYLE[key.status].tint}>
                    {t(`keys.status.${key.status}`)}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-[0.8125rem] text-muted-foreground">
                  <time dateTime={key.created_at} title={format.dateTime(key.created_at)}>
                    {format.relative(key.created_at)}
                  </time>
                </TableCell>
                <TableCell className="whitespace-nowrap text-[0.8125rem] text-muted-foreground">
                  {key.expires_at ? (
                    <time dateTime={key.expires_at} title={format.dateTime(key.expires_at)}>
                      {format.relative(key.expires_at)}
                    </time>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  {live && (
                    <fieldset className="flex justify-end gap-1">
                      <legend className="sr-only">{t("keys.rowActions", { keyId: key.key_id })}</legend>
                      {key.status === "active" && (
                        <Button variant="ghost" size="xs" onClick={() => setConfirming({ action: "rotate", key })}>
                          <RefreshCwIcon aria-hidden="true" />
                          {t("keys.rotate")}
                        </Button>
                      )}
                      <Button
                        variant="destructive-ghost"
                        size="xs"
                        onClick={() => setConfirming({ action: "revoke", key })}
                      >
                        <TrashIcon aria-hidden="true" />
                        {t("keys.revoke")}
                      </Button>
                    </fieldset>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </tbody>
      </Table>
    );

  const action = confirming?.action === "rotate" ? rotate : revoke;

  return (
    <Card aria-labelledby="keys-title">
      <CardHeader
        title={t("keys.title")}
        titleId="keys-title"
        description={t("keys.intro")}
        actions={
          canManage && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden="true" />
              {t("keys.create")}
            </Button>
          )
        }
      />
      {body}

      <CreateKeyDialog
        open={creating}
        onOpenChange={(open) => {
          setCreating(open);
          if (!open) create.reset();
        }}
        onCreate={(name) => create.mutate(name)}
        pending={create.isPending}
        error={create.error}
      />
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null);
            rotate.reset();
            revoke.reset();
          }
        }}
        title={confirming ? t(`${confirming.action}Dialog.title`, { keyId: confirming.key.key_id }) : ""}
        body={confirming ? t(`${confirming.action}Dialog.body`) : ""}
        confirm={confirming ? t(`${confirming.action}Dialog.submit`) : ""}
        destructive={confirming?.action === "revoke"}
        pending={action.isPending}
        error={action.error}
        onConfirm={() => confirming && action.mutate(confirming.key.key_id)}
      />
      <SecretKeyDialog issued={issued} onClose={() => setIssued(null)} />
    </Card>
  );
}
