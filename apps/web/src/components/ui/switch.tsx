import { Switch as SwitchPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-4.5 w-8 shrink-0 cursor-pointer items-center rounded-full border border-input bg-muted p-px transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-3.5 rounded-full bg-background shadow-sm ring-1 ring-black/5 transition-transform duration-150 data-[state=checked]:translate-x-3.5 rtl:data-[state=checked]:-translate-x-3.5" />
    </SwitchPrimitive.Root>
  );
}
