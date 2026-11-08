import { CompassIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { EmptyState } from "../components/states";
import { Button } from "../components/ui/button";

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center">
      <EmptyState
        icon={<CompassIcon />}
        title={t("states.notFoundTitle")}
        body={t("states.notFoundBody")}
        action={
          <Button asChild variant="outline">
            <Link to="/">{t("states.goHome")}</Link>
          </Button>
        }
      />
    </main>
  );
}
