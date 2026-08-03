import { describe, expect, it } from "vitest";

import {
  codeFontChoices,
  uiFontChoices,
  withCurrentFont,
} from "./appearanceFontChoices";
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
} from "./appearancePreferences";

describe("font choices", () => {
  it("offers the shipped defaults as the first pick", () => {
    expect([
      uiFontChoices("zh")[0].value,
      codeFontChoices("zh")[0].value,
    ]).toEqual([DEFAULT_UI_FONT_STACK, DEFAULT_CODE_FONT_STACK]);
  });

  it("keeps a fallback chain on every pick so a missing font still renders", () => {
    const withoutFallback = [
      ...uiFontChoices("en"),
      ...codeFontChoices("en"),
    ].filter((choice) => !choice.value.includes(","));

    expect(withoutFallback).toEqual([]);
  });

  it("localizes the system entry", () => {
    expect([uiFontChoices("zh")[0].label, uiFontChoices("en")[0].label]).toEqual(
      ["系统默认", "System default"],
    );
  });
});

describe("withCurrentFont", () => {
  it("leaves the list alone when the current value is already offered", () => {
    const choices = uiFontChoices("en");

    expect(withCurrentFont(choices, DEFAULT_UI_FONT_STACK)).toEqual(choices);
  });

  it("surfaces an unrecognized stack instead of silently showing another font", () => {
    const choices = withCurrentFont(uiFontChoices("en"), '"Comic Sans MS", serif');

    // Without this the select would fall back to its first option and misreport
    // which font is actually in effect.
    expect(choices[0]).toEqual({
      label: "Comic Sans MS",
      value: '"Comic Sans MS", serif',
    });
  });
});
