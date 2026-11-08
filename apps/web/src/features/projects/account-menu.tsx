import { ChevronsUpDownIcon, LogOutIcon, ShieldCheckIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useSession } from "../auth/session";

function Avatar({ email }: { email: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold uppercase text-foreground"
    >
      {Array.from(email)[0] ?? "·"}
    </span>
  );
}

export function AccountMenu() {
  const { t } = useTranslation();
  const { user, signOut } = useSession();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="group flex min-w-0 items-center gap-2 rounded-lg p-1 text-start text-[0.8125rem] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted lg:w-full lg:px-1.5"
        aria-label={t("account.menu")}
      >
        <Avatar email={user.email} />
        <span className="hidden min-w-0 flex-1 truncate font-medium lg:block">{user.email}</span>
        <ChevronsUpDownIcon
          className="hidden size-4 shrink-0 text-muted-foreground group-hover:text-foreground lg:block"
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex items-center gap-2.5 py-2">
          <Avatar email={user.email} />
          <span className="min-w-0">
            <span className="block font-normal">{t("account.signedInAs")}</span>
            <span className="block truncate text-[0.8125rem] font-medium text-foreground">{user.email}</span>
          </span>
        </DropdownMenuLabel>
        {user.instance_role === "admin" && (
          <DropdownMenuLabel className="flex items-center gap-1.5 pt-0 font-normal">
            <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
            {t("account.instanceAdmin")}
          </DropdownMenuLabel>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOutIcon aria-hidden="true" />
          {t("account.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
