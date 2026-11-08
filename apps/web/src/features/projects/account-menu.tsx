import { LogOutIcon, UserIcon } from "lucide-react";
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

export function AccountMenu() {
  const { t } = useTranslation();
  const { user, signOut } = useSession();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex min-w-0 items-center gap-2 lg:flex-1 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("account.menu")}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <UserIcon className="size-3.5" aria-hidden="true" />
        </span>
        <span className="hidden min-w-0 truncate lg:inline">{user.email}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuLabel>
          {t("account.signedInAs")}
          <span className="block truncate text-sm text-foreground">{user.email}</span>
          {user.instance_role === "admin" && <span className="block">{t("account.instanceAdmin")}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOutIcon aria-hidden="true" />
          {t("account.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
