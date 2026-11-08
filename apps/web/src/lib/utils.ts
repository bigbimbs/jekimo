import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Only same-app paths, so a `next` parameter cannot send the user to another site. */
export function safeNextPath(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}
