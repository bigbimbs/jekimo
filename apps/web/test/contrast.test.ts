// WCAG 2.2 contrast for the theme tokens in src/index.css: 4.5:1 for text
// (1.4.3) and 3:1 for meaningful non-text colors such as focus rings, field
// borders, and status dots (1.4.11), in both themes.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const TEXT = 4.5;
const UI = 3;

function tokens(selector: string): Map<string, string> {
  const block = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(CSS)?.[1] ?? "";
  return new Map([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1] ?? "", m[2] ?? ""]));
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `amount` of `top` over `base`, as a tinted badge background is drawn. */
function mix(top: string, base: string, amount: number): string {
  const a = rgb(top);
  const b = rgb(base);
  const c = a.map((v, i) => Math.round(v * amount + (b[i] ?? 0) * (1 - amount)));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const SURFACES = ["background", "sidebar", "popover", "muted", "code"];
const STATUS = ["severity-debug", "severity-info", "severity-warning", "severity-error", "severity-fatal"];
const TINTED = [...STATUS, "success", "warning", "destructive"];

for (const theme of [":root", ".dark"]) {
  describe(`${theme} theme contrast`, () => {
    const t = tokens(theme);
    const get = (name: string) => {
      const value = t.get(name);
      if (!value) throw new Error(`${theme} has no hex value for --${name}`);
      return value;
    };
    const failures: string[] = [];
    const check = (fg: string, bg: string, min: number, label = `${fg} on ${bg}`) => {
      const r = ratio(fg.startsWith("#") ? fg : get(fg), bg.startsWith("#") ? bg : get(bg));
      if (r < min) failures.push(`${label}: ${r.toFixed(2)} < ${min}`);
    };

    it("meets AA for text and 3:1 for meaningful UI colors", () => {
      for (const surface of SURFACES) {
        check("foreground", surface, TEXT);
        check("muted-foreground", surface, TEXT);
      }
      check("primary-foreground", "primary", TEXT);
      check("destructive-foreground", "destructive", TEXT);
      check("secondary-foreground", "secondary", TEXT);
      for (const surface of ["background", "popover"]) {
        check("primary", surface, TEXT);
        check("destructive", surface, TEXT);
        check("ring", surface, UI);
        check("input", surface, UI);
      }
      for (const color of TINTED) {
        const tint = mix(get(color), get("background"), 0.1);
        check(get("foreground"), tint, TEXT, `foreground on ${color} tint`);
        check(get(color), tint, UI, `${color} dot on its tint`);
        check(color, "background", UI);
      }
      expect(failures).toEqual([]);
    });
  });
}
