import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "../../constants/theme";
import { renderApp } from "../../test/render";
import { ThemeToggle } from "./theme-toggle";

function systemDark(dark: boolean) {
  vi.mocked(window.matchMedia).mockImplementation(
    (query) =>
      ({
        matches: dark,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

describe("ThemeToggle", () => {
  it("follows the operating system by default", () => {
    systemDark(true);
    renderApp(<ThemeToggle />);
    expect(screen.getByRole("radio", { name: "System theme" })).toBeChecked();
    expect(document.documentElement).toHaveClass("dark");
  });

  it("switches theme and remembers the choice per browser", async () => {
    systemDark(false);
    renderApp(<ThemeToggle />);
    expect(document.documentElement).not.toHaveClass("dark");

    await userEvent.click(screen.getByRole("radio", { name: "Dark theme" }));
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await userEvent.click(screen.getByRole("radio", { name: "Light theme" }));
    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    await userEvent.click(screen.getByRole("radio", { name: "System theme" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("starts from the saved choice", () => {
    systemDark(false);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderApp(<ThemeToggle />);
    expect(screen.getByRole("radio", { name: "Dark theme" })).toBeChecked();
    expect(document.documentElement).toHaveClass("dark");
  });
});
