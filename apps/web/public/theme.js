// Applies the saved or system theme before the first paint, so the page never
// flashes the wrong theme. A file rather than an inline script, so the
// Content-Security-Policy can stay script-src 'self'. Keep the storage key in
// step with THEME_STORAGE_KEY in src/constants/theme.ts.
(() => {
  let preference = "system";
  try {
    preference = localStorage.getItem("jekimo.theme") || "system";
  } catch {}
  const dark =
    preference === "dark" || (preference !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();
