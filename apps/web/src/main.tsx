import "@fontsource-variable/inter";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/app";
import { applyDocumentLocale, createI18n } from "./lib/i18n";

const i18n = createI18n();
applyDocumentLocale(i18n);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App i18n={i18n} />
    </StrictMode>,
  );
}
