import { useState } from "react";
import { useTranslation } from "react-i18next";
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
          <span className={cn(!dim && "font-semibold")}>{parts.fn}</span>
          <span className="text-muted-foreground"> (</span>
        </>
      )}
      <span>{parts.location}</span>
      <span className="text-muted-foreground">
        {parts.position}
        {parts.fn && ")"}
      </span>
    </>
  );
}

export function StackTrace({ stacktrace }: { stacktrace: string }) {
  const { t } = useTranslation("issues");
  const [appOnly, setAppOnly] = useState(false);
  const lines = parseStack(stacktrace);
  const hasLibraryFrames = lines.some((l) => l.frame && !l.inApp);
  const visible = appOnly ? lines.filter((l) => !l.frame || l.inApp) : lines;

  return (
    <div className="grid gap-2">
      {hasLibraryFrames && (
        <label className="flex items-center gap-2 justify-self-end text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 accent-(--primary)"
            checked={appOnly}
            onChange={(e) => setAppOnly(e.target.checked)}
          />
          {t("detail.appFramesOnly")}
        </label>
      )}
      <pre
        className="overflow-x-auto rounded-md border border-border bg-code py-3 font-mono text-[0.8125rem] leading-6"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
        tabIndex={0}
      >
        <code>
          {visible.map((line, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: stack lines repeat and have no identity beyond position
              key={i}
              className={cn(
                "block border-s-2 border-transparent px-4",
                !line.frame && "font-semibold",
                line.frame && line.inApp && "border-muted-foreground bg-muted text-foreground",
                line.frame && !line.inApp && "text-muted-foreground",
              )}
            >
              {line.frame ? <Frame line={line} /> : line.text || " "}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
