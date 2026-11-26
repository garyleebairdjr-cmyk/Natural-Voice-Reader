import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ACCENT_TOKENS,
  ACCENTS,
  THEME_BOOT_SCRIPT,
  THEME_COLOR,
  THEME_SURFACES,
  defaultInk,
  inkFits,
  migrateInk,
  resolveTheme,
  isThemeName,
} from "./appearance.ts";

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

describe("appearance", () => {
  it("uses one accent set in both modes and migrates the old reading inks", () => {
    assert.deepEqual(
      ACCENTS.map((item) => item.id),
      ["amber", "sky", "sage", "violet"],
    );
    assert.equal(defaultInk(), "amber");
    assert.equal(migrateInk("paper"), "violet");
    assert.equal(migrateInk("mint"), "sage");
    assert.equal(migrateInk("ink"), "amber");
    assert.equal(migrateInk("navy"), "sky");
    assert.equal(migrateInk("brown"), "amber");
    assert.equal(migrateInk("forest"), "sage");
    assert.equal(migrateInk("sky"), "sky");
    assert.equal(migrateInk("unknown"), "amber");
    assert.equal(inkFits("light", "violet"), true);
    assert.equal(inkFits("dark", "paper"), false);
  });

  it("resolves the system theme from prefers-color-scheme", () => {
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("dark", false), "dark");
    assert.equal(resolveTheme("system", true), "dark");
    assert.equal(resolveTheme("system", false), "light");
    assert.equal(isThemeName("system"), true);
    assert.equal(isThemeName("dim"), false);
  });

  it("keeps the boot script in sync with the ink migration", () => {
    assert.match(THEME_BOOT_SCRIPT, /paper:"violet"/);
    assert.match(THEME_BOOT_SCRIPT, /mint:"sage"/);
    assert.match(THEME_BOOT_SCRIPT, /prefers-color-scheme: dark/);
    assert.match(THEME_BOOT_SCRIPT, /lane-reader/);
  });

  it("meets WCAG AA contrast for text, accents, badges, and the volume track", () => {
    for (const mode of ["light", "dark"] as const) {
      const surface = THEME_SURFACES[mode];
      for (const ground of [surface.bg, surface.surface, surface.raise] as const) {
        assert.ok(contrast(surface.fg, ground) >= 4.5, `${mode} fg on ${ground}`);
        assert.ok(contrast(surface.muted, ground) >= 4.5, `${mode} muted on ${ground}`);
        assert.ok(contrast(surface.danger, ground) >= 4.5, `${mode} danger on ${ground}`);
        assert.ok(contrast(surface.read, ground) >= 4.5, `${mode} read on ${ground}`);
      }
      assert.ok(contrast(surface.track, surface.bg) >= 3, `${mode} volume track`);
      for (const [name, token] of Object.entries(ACCENT_TOKENS[mode])) {
        for (const ground of [surface.bg, surface.surface, surface.raise] as const) {
          assert.ok(contrast(token.accent, ground) >= 4.5, `${mode} ${name} text on ${ground} (${contrast(token.accent, ground).toFixed(2)})`);
        }
        assert.ok(contrast(token.on, token.accent) >= 4.5, `${mode} ${name} on-accent`);
        assert.ok(contrast(token.on, token.hover) >= 4.5, `${mode} ${name} on hover`);
      }
    }
  });

  it("keeps styles.css and the boot script in sync with the palette", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").toLowerCase();
    const block = (selector: string) => {
      const at = css.indexOf(selector + " {");
      assert.ok(at >= 0, `missing ${selector}`);
      return css.slice(at, css.indexOf("}", at));
    };
    for (const mode of ["light", "dark"] as const) {
      const surfaces = block(`html[data-theme="${mode}"]`);
      for (const [name, value] of Object.entries(THEME_SURFACES[mode])) {
        assert.ok(surfaces.includes(`--color-${name}: ${value};`), `${mode} ${name}`);
      }
      for (const [id, token] of Object.entries(ACCENT_TOKENS[mode])) {
        const accent = block(`html[data-theme="${mode}"][data-ink="${id}"]`);
        assert.ok(accent.includes(`--color-amber: ${token.accent};`), `${mode} ${id} accent`);
        assert.ok(accent.includes(`--color-ink: ${token.on};`), `${mode} ${id} on`);
      }
      assert.ok(THEME_BOOT_SCRIPT.includes(THEME_COLOR[mode]), `${mode} theme-color in boot script`);
    }
  });
});
