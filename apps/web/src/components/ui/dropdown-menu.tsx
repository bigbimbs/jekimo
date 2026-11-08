import { DropdownMenu as MenuPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-52 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/5 data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in dark:shadow-black/40",
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

const itemClass =
  "relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-[0.8125rem] outline-none transition-colors data-[disabled]:pointer-events-none data-[highlighted]:bg-muted data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof MenuPrimitive.Item>) {
  return <MenuPrimitive.Item className={cn(itemClass, className)} {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(itemClass, "ps-7", className)} {...props}>
      <span className="absolute start-2 flex size-3.5 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <span className="block size-2 rounded-full bg-primary" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cn("px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}
