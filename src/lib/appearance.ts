export type ThemeName = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export type Ink = {
  id: AccentId;
  label: string;
};

export const ACCENT_IDS = ["amber", "sky", "sage", "violet"] as const;
export type AccentId = (typeof ACCENT_IDS)[number];

/** One accent set for both light and dark. Ids stay stable so saved settings carry over. */
export const ACCENTS: Ink[] = [
  { id: "amber", label: "Solar" },
  { id: "sky", label: "Cyan" },
  { id: "sage", label: "Mint" },
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
    bg: "#f4f5f9",
    surface: "#ffffff",
    raise: "#e8eaf1",
    fg: "#0c0e14",
    muted: "#4a5064",
    line: "#d5d9e3",
    track: "#7b8194",
    danger: "#c0262d",
    read: "#0c0e14",
  },
  dark: {
    bg: "#07080d",
    surface: "#10121a",
    raise: "#191c27",
    fg: "#f4f5f8",
    muted: "#9ba1b5",
    line: "#272b3a",
    track: "#6b7186",
    danger: "#ff8a8a",
    read: "#eef0f6",
  },
} as const;

/**
 * `accent` is used for text and fills; `glow` is a second, decorative hue for
 * gradients and the aurora backdrop only, never for text.
 */
export const ACCENT_TOKENS = {
  light: {
    amber: { accent: "#9a4800", hover: "#7f3b00", soft: "#fdeedd", on: "#fff8f1", glow: "#ff5f8f" },
    sky: { accent: "#075f9e", hover: "#054d82", soft: "#e0effb", on: "#f4f9ff", glow: "#6d5cff" },
    sage: { accent: "#066b45", hover: "#045a39", soft: "#dcf4e9", on: "#f0fbf6", glow: "#00a3c4" },
    violet: { accent: "#6633d1", hover: "#5528b4", soft: "#ece6fd", on: "#f8f5ff", glow: "#e0459e" },
  },
  dark: {
    amber: { accent: "#ffb547", hover: "#ffc56e", soft: "#33240c", on: "#1a0f00", glow: "#ff5f8f" },
    sky: { accent: "#5cd3ff", hover: "#85dfff", soft: "#0c2a38", on: "#001820", glow: "#7c6cff" },
    sage: { accent: "#4ee6a6", hover: "#78edbd", soft: "#0c2f22", on: "#00190f", glow: "#36c8ff" },
    violet: { accent: "#b69cff", hover: "#c9b6ff", soft: "#241b44", on: "#12082e", glow: "#ff7ad9" },
  },
} as const;

/** Browser chrome color for each resolved theme. */
export const THEME_COLOR = { light: THEME_SURFACES.light.bg, dark: THEME_SURFACES.dark.bg } as const;

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
    if (meta) meta.setAttribute("content", resolved === "light" ? "#f4f5f9" : "#07080d");
  } catch (e) {}
})();`;
