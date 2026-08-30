import { describe, expect, it } from "vitest";

import {
  DEFAULT_APPEARANCE,
  supportsFontSmoothing,
} from "./appearancePreferences";
import { appearanceRootState, resolveThemeMode } from "./applyAppearance";

describe("resolveThemeMode", () => {
  it("keeps explicit modes regardless of the system preference", () => {
    expect([
      resolveThemeMode("light", /*prefersDark*/ true),
      resolveThemeMode("dark", /*prefersDark*/ false),
    ]).toEqual(["light", "dark"]);
  });

  it("follows the system preference in system mode", () => {
    expect([
      resolveThemeMode("system", /*prefersDark*/ true),
      resolveThemeMode("system", /*prefersDark*/ false),
    ]).toEqual(["dark", "light"]);
  });
});

describe("supportsFontSmoothing", () => {
  it("is macOS only because it maps to a macOS rendering path", () => {
    expect([
      supportsFontSmoothing("mac"),
      supportsFontSmoothing("windows"),
      supportsFontSmoothing("linux"),
    ]).toEqual([true, false, false]);
  });
});

describe("appearanceRootState", () => {
  it("maps preferences to CSS variables and data attributes", () => {
    expect(
      appearanceRootState({
        os: "mac",
        prefersReducedMotion: false,
        surface: "desktop",
        preferences: {
          ...DEFAULT_APPEARANCE,
          accent: "#123456",
          background: "#ffffff",
          codeFontFamily: "Fira Code",
          codeFontSize: 14,
          contrast: 60,
          diffMarkers: "sign",
          foreground: "#1a1c1f",
          reduceMotion: "on",
          translucentSidebar: false,
          uiFontFamily: "Inter",
          uiFontSize: 13,
        },
      }),
    ).toEqual({
      attributes: {
        "data-diff-markers": "sign",
        "data-font-smoothing": "true",
        "data-os": "mac",
        "data-reduce-motion": "true",
        "data-surface": "desktop",
        "data-translucent-sidebar": "false",
      },
      variables: {
        "--user-accent": "#123456",
        "--user-background": "#ffffff",
        "--user-code-font": "Fira Code",
        "--user-code-font-size": "14px",
        "--user-contrast": "0.6",
        "--user-foreground": "#1a1c1f",
        "--user-ui-font": "Inter",
        "--user-ui-font-size": "13px",
        // 13px against the 12px default: every px font-size gains 1px.
        "--user-ui-font-delta": "1px",
      },
    });
  });

  it("defers to the system setting when reduce motion is in system mode", () => {
    const reduced = appearanceRootState({
      os: "mac",
      prefersReducedMotion: true,
      preferences: { ...DEFAULT_APPEARANCE, reduceMotion: "system" },
      surface: "desktop",
    });
    const notReduced = appearanceRootState({
      os: "mac",
      prefersReducedMotion: false,
      preferences: { ...DEFAULT_APPEARANCE, reduceMotion: "system" },
      surface: "desktop",
    });

    expect([
      reduced.attributes["data-reduce-motion"],
      notReduced.attributes["data-reduce-motion"],
    ]).toEqual(["true", "false"]);
  });

  it("ignores an explicit system preference when the user forces motion off", () => {
    const state = appearanceRootState({
      os: "mac",
      prefersReducedMotion: true,
      preferences: { ...DEFAULT_APPEARANCE, reduceMotion: "off" },
      surface: "desktop",
    });

    expect(state.attributes["data-reduce-motion"]).toBe("false");
  });

  it("disables font smoothing off macOS even when the user enabled it", () => {
    const state = appearanceRootState({
      os: "windows",
      prefersReducedMotion: false,
      preferences: { ...DEFAULT_APPEARANCE, fontSmoothing: true },
      surface: "desktop",
    });

    expect(state.attributes["data-font-smoothing"]).toBe("false");
  });

  it("omits the theme-owned colors while they sit at their defaults", () => {
    const state = appearanceRootState({
      os: "mac",
      prefersReducedMotion: false,
      preferences: DEFAULT_APPEARANCE,
      surface: "desktop",
    });

    // These defaults differ per theme, so pinning the light value here would
    // override dark mode's own background, text, and accent.
    expect([
      "--user-accent" in state.variables,
      "--user-background" in state.variables,
      "--user-foreground" in state.variables,
    ]).toEqual([false, false, false]);
  });

  it("emits the theme-owned colors once the user overrides them", () => {
    const state = appearanceRootState({
      os: "mac",
      prefersReducedMotion: false,
      preferences: {
        ...DEFAULT_APPEARANCE,
        accent: "#ff8800",
        background: "#0b0b0b",
        foreground: "#fafafa",
      },
      surface: "desktop",
    });

    expect([
      state.variables["--user-accent"],
      state.variables["--user-background"],
      state.variables["--user-foreground"],
    ]).toEqual(["#ff8800", "#0b0b0b", "#fafafa"]);
  });

  it("expresses the UI size as a delta so layout dimensions stay fixed", () => {
    const deltaAt = (uiFontSize: number) =>
      appearanceRootState({
        os: "mac",
        prefersReducedMotion: false,
        preferences: { ...DEFAULT_APPEARANCE, uiFontSize },
        surface: "desktop",
      }).variables["--user-ui-font-delta"];

    // A zoom would scale the window and spacing too; a delta only moves text.
    expect([deltaAt(10), deltaAt(12), deltaAt(18)]).toEqual([
      "-2px",
      "0px",
      "6px",
    ]);
  });

  it("drops the translucent sidebar on web, which has no window to blur", () => {
    const state = appearanceRootState({
      os: "mac",
      prefersReducedMotion: false,
      preferences: { ...DEFAULT_APPEARANCE, translucentSidebar: true },
      surface: "web",
    });

    expect(state.attributes["data-translucent-sidebar"]).toBe("false");
  });
});
