export type Theme = "light" | "dark";

const storageKey = "crewon-ui-theme";

export function getInitialTheme(): Theme {
  const themeOverride = new URLSearchParams(window.location.search).get("theme");
  if (themeOverride === "light" || themeOverride === "dark") {
    return themeOverride;
  }

  const storedTheme = localStorage.getItem(storageKey);

  if (storedTheme === "light" || storedTheme === "dark") {
    return storedTheme;
  }

  return "dark";
}

export function persistTheme(theme: Theme): void {
  localStorage.setItem(storageKey, theme);
}
