import { useTranslation } from "react-i18next";
import { useFormat } from "../../lib/format";
import type { StoredEvent } from "../../types/api";
import { waterfallSpans } from "./waterfall";

export function TraceWaterfall({ records, hasMore }: { records: StoredEvent[]; hasMore: boolean }) {
  const { t } = useTranslation("traces");
  const format = useFormat();
  const spans = waterfallSpans(records);
  if (!spans.length) return <p className="text-sm text-muted-foreground">{t("noTiming")}</p>;
  const start = spans.reduce((earliest, span) => Math.min(earliest, span.start), Infinity);
  const duration = spans.reduce((latest, span) => Math.max(latest, span.start + span.duration - start), 0);
  const scale = duration || 1;
  const number = (value: number) => format.number(value, { maximumFractionDigits: 2 });
  return (
    <section aria-label={t("waterfall")} className="grid gap-3 rounded-lg border border-border p-4">
      <h2 className="font-semibold">{t("waterfall")}</h2>
      <p className="text-sm text-muted-foreground">{t("timingLimits")}</p>
      {hasMore && <p className="text-sm text-muted-foreground">{t("partial")}</p>}
      <p className="text-sm">{t("timingRange", { duration: number(duration), count: spans.length })}</p>
      <div className="overflow-x-auto">
        <div className="grid min-w-[560px] gap-3">
          {spans.map((span) => (
            <div key={span.id} className="grid grid-cols-[minmax(180px,1fr)_2fr] items-center gap-4">
              <div style={{ paddingInlineStart: `${span.depth * 12}px` }} className="min-w-0 text-sm">
                <a className="break-words font-medium underline underline-offset-2" href={`#record-${span.eventId}`}>
                  {span.name}
                </a>
                <p className="text-xs text-muted-foreground">
                  {span.operation} · {t(span.status)}
                </p>
                {span.missingParent && <p className="text-xs text-muted-foreground">{t("missingParent")}</p>}
              </div>
              <div>
                <div className="relative h-3 overflow-hidden rounded bg-muted" aria-hidden="true">
                  <div
                    className={`absolute h-full min-w-px rounded ${span.status === "error" ? "bg-destructive" : "bg-primary"}`}
                    style={{
                      insetInlineStart: `${((span.start - start) / scale) * 100}%`,
                      width: `${(span.duration / scale) * 100}%`,
                    }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("timing", { offset: number(span.start - start), duration: number(span.duration) })}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
