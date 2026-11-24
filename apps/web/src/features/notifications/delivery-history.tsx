import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ErrorState } from "../../components/states";
import { Button } from "../../components/ui/button";
import { useApi } from "../../lib/api-context";
import { useFormat } from "../../lib/format";

export function DeliveryHistory({ projectId }: { projectId?: string }) {
  const { t } = useTranslation("notifications");
  const api = useApi();
  const format = useFormat();
  const rows = useQuery({
    queryKey: projectId ? ["project", projectId, "deliveries"] : ["admin", "email-deliveries"],
    queryFn: () => api.listNotificationDeliveries(projectId),
    refetchInterval: 10000,
  });
  const errors = t("deliveryError", { returnObjects: true });
  return (
    <section className="grid gap-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{t("deliveryTitle")}</h2>
        <Button variant="outline" onClick={() => void rows.refetch()}>
          {t("refresh")}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t("deliveryIntro")}</p>
      {rows.isError && <ErrorState error={rows.error} />}
      {rows.data?.length === 0 && <p className="text-sm text-muted-foreground">{t("noDeliveries")}</p>}
      <div className="grid gap-2">
        {rows.data?.map((row) => (
          <article key={row.id} className="grid gap-2 rounded-md bg-muted/40 p-3 text-sm sm:grid-cols-2">
            <div className="font-medium">{row.channelName}</div>
            <div>{t(`deliveryStatus.${row.status}`)}</div>
            <div className="text-muted-foreground">{format.dateTime(row.createdAt)}</div>
            <div>
              {t("attempts")}: {format.number(row.attempts)}
            </div>
            {row.error && (
              <p className="text-destructive sm:col-span-2">
                {errors[row.error as keyof typeof errors] ?? errors.generic}
              </p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
