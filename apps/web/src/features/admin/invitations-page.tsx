import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { EmptyState, ErrorState, PageLoader } from "../../components/states";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useApi } from "../../lib/api-context";
import { useFormat } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import type { IssuedAccountLink } from "../../types/admin";
import type { Invitation } from "../../types/api";
import { AccountLinkDialog } from "./account-link-dialog";
import { AdminShell } from "./admin-shell";
import { InviteDialog, RevokeInvitationDialog } from "./invitation-dialogs";

export function InvitationsPage() {
  const { t } = useTranslation("admin");
  return (
    <AdminShell title={t("invitations")} description={t("invitationsIntro")}>
      <Invitations />
    </AdminShell>
  );
}

function Invitations() {
  const { t } = useTranslation("admin");
  const api = useApi();
  const format = useFormat();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [issued, setIssued] = useState<IssuedAccountLink | null>(null);
  const [revoke, setRevoke] = useState<Invitation | null>(null);
  const [revoked, setRevoked] = useState(false);
  const invitations = useQuery({ queryKey: queryKeys.invitations, queryFn: api.listInvitations });
  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.invitations }),
      queryClient.invalidateQueries({ queryKey: ["admin", "audit"] }),
    ]);
  }
  function closeInvite() {
    const next = new URLSearchParams(params);
    next.delete("invite");
    setParams(next, { replace: true });
  }
  return (
    <>
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={invitations.isFetching} onClick={() => void invitations.refetch()}>
          {t("refresh")}
        </Button>
        <Button
          onClick={() => {
            setRevoked(false);
            setParams({ invite: "1" }, { replace: true });
          }}
        >
          {t("invite")}
        </Button>
      </div>
      {revoked && (
        <p role="status" className="text-sm text-success">
          {t("revoked")}
        </p>
      )}
      {invitations.isError && invitations.data && (
        <ErrorState error={invitations.error} onRetry={() => invitations.refetch()} />
      )}
      <Card>
        {invitations.isPending ? (
          <PageLoader />
        ) : !invitations.data ? (
          <ErrorState error={invitations.error} onRetry={() => invitations.refetch()} />
        ) : invitations.data.length === 0 ? (
          <EmptyState title={t("noneInvitations")} body={t("noneInvitationsBody")} />
        ) : (
          <Table>
            <caption className="sr-only">{t("invitations")}</caption>
            <TableHeader>
              <TableRow>
                {(["email", "role", "created", "expires", "actions"] as const).map((key) => (
                  <TableHead key={key}>{t(key)}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <tbody>
              {invitations.data.map((invitation) => (
                <TableRow key={invitation.id}>
                  <TableCell className="font-medium">{invitation.email}</TableCell>
                  <TableCell>{t(`roles.${invitation.instance_role}`)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {format.dateTime(invitation.created_at)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {format.dateTime(invitation.expires_at)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRevoked(false);
                        setRevoke(invitation);
                      }}
                    >
                      {t("revoke")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {params.get("invite") === "1" && (
        <InviteDialog
          onClose={closeInvite}
          onIssued={(link) => {
            setIssued(link);
            void refresh();
          }}
        />
      )}
      {revoke && (
        <RevokeInvitationDialog
          invitation={revoke}
          onClose={() => setRevoke(null)}
          onRevoked={async () => {
            queryClient.setQueryData<Invitation[]>(queryKeys.invitations, (current) =>
              current?.filter((row) => row.id !== revoke.id),
            );
            setRevoked(true);
            await refresh();
          }}
        />
      )}
      {issued && <AccountLinkDialog issued={issued} onClose={() => setIssued(null)} />}
    </>
  );
}
