import { Label as LabelPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn("text-[0.8125rem] font-medium leading-none", className)} {...props} />;
}
