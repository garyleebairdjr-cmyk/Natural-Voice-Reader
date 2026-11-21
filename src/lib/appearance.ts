export type ThemeName = "dark" | "light";

export type Ink = {
  id: string;
  label: string;
};

export const DARK_INKS: Ink[] = [
  { id: "paper", label: "Paper" },
  { id: "amber", label: "Amber" },
  { id: "sky", label: "Sky" },
  { id: "mint", label: "Mint" },
];

export const LIGHT_INKS: Ink[] = [
  { id: "ink", label: "Ink" },
  { id: "navy", label: "Navy" },
  { id: "brown", label: "Brown" },
  { id: "forest", label: "Forest" },
];

export function inksFor(theme: ThemeName): Ink[] {
  return theme === "light" ? LIGHT_INKS : DARK_INKS;
}

export function inkFits(theme: ThemeName, ink: string): boolean {
  return inksFor(theme).some((item) => item.id === ink);
}

export function defaultInk(theme: ThemeName): string {
  return inksFor(theme)[0].id;
}
