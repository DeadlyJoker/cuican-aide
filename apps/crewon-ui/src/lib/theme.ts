export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "crewon-ui-theme";

export function getInitialTheme(): Theme {
  const themeOverride = new URLSearchParams(window.location.search).get(
    "theme",
  );
  if (themeOverride === "light" || themeOverride === "dark") {
    return themeOverride;
  }

  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);

  if (storedTheme === "light" || storedTheme === "dark") {
    return storedTheme;
  }

  return "dark";
}

export function persistTheme(theme: Theme): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}
