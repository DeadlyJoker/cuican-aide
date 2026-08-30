import { describe, expect, it } from "vitest";

import { DEFAULT_APPEARANCE } from "./appearancePreferences";
import {
  APPEARANCE_FIELD_IDS,
  appearancePanelFields,
} from "./appearancePanelFields";

function fieldIds(params: {
  os: "linux" | "mac" | "windows";
  surface: "desktop" | "web";
}): string[] {
  return appearancePanelFields({
    locale: "zh",
    os: params.os,
    preferences: DEFAULT_APPEARANCE,
    surface: params.surface,
    uiLocale: "zh",
  }).map((field) => field.id);
}

describe("appearancePanelFields", () => {
  it("offers font smoothing only on macOS", () => {
    expect({
      mac: fieldIds({ os: "mac", surface: "desktop" }).includes(
        APPEARANCE_FIELD_IDS.fontSmoothing,
      ),
      windows: fieldIds({ os: "windows", surface: "desktop" }).includes(
        APPEARANCE_FIELD_IDS.fontSmoothing,
      ),
      linux: fieldIds({ os: "linux", surface: "desktop" }).includes(
        APPEARANCE_FIELD_IDS.fontSmoothing,
      ),
    }).toEqual({ mac: true, windows: false, linux: false });
  });

  it("offers a translucent sidebar only on the desktop surface", () => {
    expect({
      desktop: fieldIds({ os: "mac", surface: "desktop" }).includes(
        APPEARANCE_FIELD_IDS.translucentSidebar,
      ),
      web: fieldIds({ os: "mac", surface: "web" }).includes(
        APPEARANCE_FIELD_IDS.translucentSidebar,
      ),
    }).toEqual({ desktop: true, web: false });
  });

  it("keeps the cross-platform fields available on web Windows", () => {
    expect(fieldIds({ os: "windows", surface: "web" })).toEqual([
      APPEARANCE_FIELD_IDS.locale,
      APPEARANCE_FIELD_IDS.themeMode,
      APPEARANCE_FIELD_IDS.accent,
      APPEARANCE_FIELD_IDS.background,
      APPEARANCE_FIELD_IDS.foreground,
      APPEARANCE_FIELD_IDS.uiFontFamily,
      APPEARANCE_FIELD_IDS.codeFontFamily,
      APPEARANCE_FIELD_IDS.uiFontSize,
      APPEARANCE_FIELD_IDS.codeFontSize,
      APPEARANCE_FIELD_IDS.contrast,
      APPEARANCE_FIELD_IDS.reduceMotion,
      APPEARANCE_FIELD_IDS.diffMarkers,
    ]);
  });

  it("describes font smoothing as macOS-native only where it applies", () => {
    const macField = appearancePanelFields({
      locale: "zh",
      os: "mac",
      preferences: DEFAULT_APPEARANCE,
      surface: "desktop",
      uiLocale: "zh",
    }).find((field) => field.id === APPEARANCE_FIELD_IDS.fontSmoothing);

    expect(macField?.description).toBe("使用 macOS 原生字体抗锯齿");
  });

  it("binds real control types to the color, size, and contrast fields", () => {
    const byId = new Map(
      appearancePanelFields({
        locale: "en",
        os: "mac",
        preferences: DEFAULT_APPEARANCE,
        surface: "desktop",
        uiLocale: "en",
      }).map((field) => [field.id, field.control]),
    );

    expect({
      accent: byId.get(APPEARANCE_FIELD_IDS.accent),
      contrast: byId.get(APPEARANCE_FIELD_IDS.contrast),
      diffMarkers: byId.get(APPEARANCE_FIELD_IDS.diffMarkers),
      smoothing: byId.get(APPEARANCE_FIELD_IDS.fontSmoothing),
      themeMode: byId.get(APPEARANCE_FIELD_IDS.themeMode),
      uiFontSize: byId.get(APPEARANCE_FIELD_IDS.uiFontSize),
    }).toEqual({
      accent: "color",
      contrast: "slider",
      diffMarkers: "segmented",
      smoothing: "toggle",
      themeMode: "segmented",
      uiFontSize: "number",
    });
  });
});
