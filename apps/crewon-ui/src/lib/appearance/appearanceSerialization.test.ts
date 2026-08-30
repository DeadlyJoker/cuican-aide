import { describe, expect, it } from "vitest";

import {
  DEFAULT_APPEARANCE,
  UI_FONT_SIZE_RANGE,
} from "./appearancePreferences";
import {
  appearanceConfigEdit,
  appearanceWithField,
  parseAppearancePreferences,
} from "./appearanceSerialization";

describe("parseAppearancePreferences", () => {
  it("falls back to defaults when the desktop table is missing", () => {
    expect(parseAppearancePreferences(null)).toEqual(DEFAULT_APPEARANCE);
  });

  it("reads a fully specified desktop table", () => {
    const parsed = parseAppearancePreferences({
      appearanceAccent: "#FF00AA",
      appearanceBackground: "#000000",
      appearanceContrast: 68,
      appearanceForeground: "#eeeeee",
      appearanceTheme: "dark",
      codeFontFamily: "Fira Code",
      codeFontSize: 15,
      diffMarkers: "sign",
      fontSmoothing: false,
      reduceMotion: "on",
      translucentSidebar: false,
      uiFontFamily: "Inter",
      uiFontSize: 14,
    });

    expect(parsed).toEqual({
      accent: "#ff00aa",
      background: "#000000",
      codeFontFamily: "Fira Code",
      codeFontSize: 15,
      contrast: 68,
      diffMarkers: "sign",
      fontSmoothing: false,
      foreground: "#eeeeee",
      reduceMotion: "on",
      themeMode: "dark",
      translucentSidebar: false,
      uiFontFamily: "Inter",
      uiFontSize: 14,
    });
  });

  it("rejects malformed colors and clamps out-of-range sizes", () => {
    const parsed = parseAppearancePreferences({
      appearanceAccent: "not-a-color",
      appearanceContrast: 999,
      codeFontSize: 2,
      uiFontSize: 99,
    });

    expect({
      accent: parsed.accent,
      codeFontSize: parsed.codeFontSize,
      contrast: parsed.contrast,
      uiFontSize: parsed.uiFontSize,
    }).toEqual({
      accent: DEFAULT_APPEARANCE.accent,
      codeFontSize: 10,
      contrast: 100,
      uiFontSize: 18,
    });
  });

  it("accepts string booleans written by config files", () => {
    const parsed = parseAppearancePreferences({
      fontSmoothing: "false",
      translucentSidebar: "true",
    });

    expect({
      fontSmoothing: parsed.fontSmoothing,
      translucentSidebar: parsed.translucentSidebar,
    }).toEqual({ fontSmoothing: false, translucentSidebar: true });
  });
});

describe("appearanceConfigEdit", () => {
  it("upserts the mapped desktop key path", () => {
    expect(appearanceConfigEdit("uiFontSize", 13)).toEqual({
      keyPath: "desktop.uiFontSize",
      mergeStrategy: "upsert",
      value: "13",
    });
  });

  it("serializes booleans as config strings", () => {
    expect(appearanceConfigEdit("translucentSidebar", false)).toEqual({
      keyPath: "desktop.translucentSidebar",
      mergeStrategy: "upsert",
      value: "false",
    });
  });
});

describe("appearanceWithField", () => {
  it("changes only the committed field", () => {
    expect(
      appearanceWithField(DEFAULT_APPEARANCE, "accent", "#3355ff"),
    ).toEqual({ ...DEFAULT_APPEARANCE, accent: "#3355ff" });
  });

  it("parses committed strings into their preference types", () => {
    const next = appearanceWithField(
      appearanceWithField(DEFAULT_APPEARANCE, "uiFontSize", "15"),
      "translucentSidebar",
      "true",
    );

    expect(next).toEqual({
      ...DEFAULT_APPEARANCE,
      translucentSidebar: true,
      uiFontSize: 15,
    });
  });

  it("keeps the previous value when a commit is out of range or malformed", () => {
    expect([
      appearanceWithField(DEFAULT_APPEARANCE, "uiFontSize", "999").uiFontSize,
      appearanceWithField(DEFAULT_APPEARANCE, "accent", "not-a-color").accent,
    ]).toEqual([
      // Clamped to the supported range rather than written through verbatim.
      UI_FONT_SIZE_RANGE.max,
      DEFAULT_APPEARANCE.accent,
    ]);
  });
});
