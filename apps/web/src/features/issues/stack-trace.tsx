import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardHeader } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";
import type { StackLine } from "../../types/issues";
import { parseStack } from "./stack";

function Frame({ line }: { line: StackLine }) {
  const { parts } = line;
  if (!parts) return <>{line.text}</>;
  const dim = !line.inApp;
  return (
    <>
      <span className="text-muted-foreground">{parts.lead}</span>
      {parts.fn && (
        <>
          <span className={cn(!dim && "font-semibold text-foreground")}>{parts.fn}</span>
          <span className="text-muted-foreground"> (</span>
        </>
      )}
      <span className={cn(!dim && "text-foreground")}>{parts.location}</span>
      <span className="text-muted-foreground">
        {parts.position}
        {parts.fn && ")"}
      </span>
    </>
  );
}

export function StackTrace({ title, stacktrace }: { title: string; stacktrace: string }) {
  const { t } = useTranslation("issues");
  const switchId = useId();
  const [appOnly, setAppOnly] = useState(false);
  const lines = parseStack(stacktrace);
  const frames = lines.filter((l) => l.frame).length;
  const hasLibraryFrames = lines.some((l) => l.frame && !l.inApp);
  const visible = appOnly ? lines.filter((l) => !l.frame || l.inApp) : lines;

  return (
    <Card aria-labelledby={`${switchId}-title`}>
      <CardHeader
        title={title}
        titleId={`${switchId}-title`}
        actions={
          <>
            <span className="text-xs tabular-nums text-muted-foreground">{t("detail.frames", { count: frames })}</span>
            {hasLibraryFrames && (
              <div className="flex items-center gap-2 border-s border-border ps-3">
                <Switch id={switchId} checked={appOnly} onCheckedChange={setAppOnly} />
                <label htmlFor={switchId} className="cursor-pointer select-none text-[0.8125rem] text-muted-foreground">
                  {t("detail.appFramesOnly")}
                </label>
              </div>
            )}
          </>
        }
      />
      <pre
        className="overflow-x-auto bg-code py-2.5 font-mono text-[0.8125rem] leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
        tabIndex={0}
      >
        <code className="block min-w-max">
          {visible.map((line, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: stack lines repeat and have no identity beyond position
              key={i}
              className={cn(
                "block border-s-2 border-transparent px-4 transition-colors hover:bg-muted/70",
                !line.frame && "pb-1 font-semibold text-foreground",
                line.frame && line.inApp && "border-muted-foreground bg-background/70 dark:bg-muted/40",
                line.frame && !line.inApp && "text-muted-foreground",
              )}
            >
              {line.frame ? <Frame line={line} /> : line.text || " "}
            </span>
          ))}
        </code>
      </pre>
    </Card>
  );
}
