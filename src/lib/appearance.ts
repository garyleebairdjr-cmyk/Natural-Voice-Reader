export type ThemeName = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export type Ink = {
  id: AccentId;
  label: string;
};

export const ACCENT_IDS = ["amber", "sky", "sage", "violet"] as const;
export type AccentId = (typeof ACCENT_IDS)[number];

/** One accent set for both light and dark. Paper/cream was a weak light accent, so that slot is now violet. */
export const ACCENTS: Ink[] = [
  { id: "amber", label: "Amber" },
  { id: "sky", label: "Sky" },
  { id: "sage", label: "Sage" },
  { id: "violet", label: "Violet" },
];

const INK_MIGRATION: Record<string, AccentId> = {
  paper: "violet",
  mint: "sage",
  ink: "amber",
  navy: "sky",
  brown: "amber",
  forest: "sage",
};

export const THEME_SURFACES = {
  light: {
    bg: "#f3eee4",
    surface: "#faf6ee",
    raise: "#ece4d6",
    fg: "#1c1914",
    muted: "#534d45",
    line: "#cfc4b3",
    track: "#8e867b",
    danger: "#b8332a",
    read: "#1c1914",
  },
  dark: {
    bg: "#14161c",
    surface: "#1c212b",
    raise: "#262d3a",
    fg: "#f2eee6",
    muted: "#a8a196",
    line: "#3e4656",
    track: "#7a808c",
    danger: "#ee8c80",
    read: "#f2eee6",
  },
} as const;

export const ACCENT_TOKENS = {
  light: {
    amber: { accent: "#8d5508", hover: "#754609", soft: "#f3e6c8", on: "#fff6e8" },
    sky: { accent: "#1a5a82", hover: "#15486a", soft: "#e3eef6", on: "#f3f8fc" },
    sage: { accent: "#1b5c40", hover: "#164a33", soft: "#e3f0e9", on: "#eff8f3" },
    violet: { accent: "#6a348f", hover: "#582b76", soft: "#efe6f7", on: "#f7f2fc" },
  },
  dark: {
    amber: { accent: "#e8a23a", hover: "#f0b14a", soft: "#3a2f1c", on: "#1a1206" },
    sky: { accent: "#7eb6d4", hover: "#90c4dc", soft: "#1c303c", on: "#0b1c26" },
    sage: { accent: "#7fb89a", hover: "#91c8aa", soft: "#1d3228", on: "#0e2418" },
    violet: { accent: "#c4a0e6", hover: "#d1b3ee", soft: "#2e243a", on: "#1a1024" },
  },
} as const;

export function isThemeName(value: unknown): value is ThemeName {
  return value === "light" || value === "dark" || value === "system";
}

export function isAccentId(value: unknown): value is AccentId {
  return typeof value === "string" && (ACCENT_IDS as readonly string[]).includes(value);
}

export function inksFor(_theme?: ThemeName): Ink[] {
  return ACCENTS;
}

export function inkFits(_theme: ThemeName, ink: string): boolean {
  return isAccentId(ink);
}

export function defaultInk(_theme?: ThemeName): AccentId {
  return "amber";
}

/** Map a saved reading-ink id onto the shared accent set. */
export function migrateInk(ink: unknown): AccentId {
  if (isAccentId(ink)) return ink;
  if (typeof ink === "string" && ink in INK_MIGRATION) return INK_MIGRATION[ink];
  return "amber";
}

export function resolveTheme(pref: ThemeName, prefersDark?: boolean): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  if (prefersDark == null && typeof window !== "undefined" && typeof window.matchMedia === "function") {
    prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return prefersDark ? "dark" : "light";
}

/** Runs in <head> before paint so the first frame matches the saved or system theme. */
export const THEME_BOOT_SCRIPT = `(function(){
  try {
    var pref = "system";
    var ink = "amber";
    var raw = localStorage.getItem("lane-reader");
    if (raw) {
      var data = JSON.parse(raw);
      var s = (data && data.state) || {};
      if (s.theme === "light" || s.theme === "dark" || s.theme === "system") pref = s.theme;
      if (typeof s.ink === "string") ink = s.ink;
    }
    var migrated = {paper:"violet",mint:"sage",ink:"amber",navy:"sky",brown:"amber",forest:"sage"};
    if (migrated[ink]) ink = migrated[ink];
    if (ink !== "amber" && ink !== "sky" && ink !== "sage" && ink !== "violet") ink = "amber";
    var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var resolved = pref === "system" ? (dark ? "dark" : "light") : pref;
    var root = document.documentElement;
    root.setAttribute("data-theme", resolved);
    root.setAttribute("data-theme-pref", pref);
    root.setAttribute("data-ink", ink);
    root.style.colorScheme = resolved;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "light" ? "#f3eee4" : "#14161c");
  } catch (e) {}
})();`;
