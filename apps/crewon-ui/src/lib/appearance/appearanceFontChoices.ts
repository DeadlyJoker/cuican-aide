import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
} from "./appearancePreferences";
import type { Locale } from "../i18n";

export type FontChoice = { label: string; value: string };

/**
 * Font choices are offered as named picks rather than a free-text CSS stack.
 * Typing a font stack by hand means knowing CSS syntax and fallback ordering,
 * and the resulting string is far too long to read in a settings field.
 *
 * Each value keeps a fallback chain so a font missing on the current machine
 * still renders in something sensible.
 */
export function uiFontChoices(locale: Locale): FontChoice[] {
  const system = locale === "zh" ? "系统默认" : "System default";
  return [
    { label: system, value: DEFAULT_UI_FONT_STACK },
    { label: "Inter", value: `Inter, ${DEFAULT_UI_FONT_STACK}` },
    {
      label: "Helvetica Neue",
      value: `"Helvetica Neue", ${DEFAULT_UI_FONT_STACK}`,
    },
    { label: "Segoe UI", value: `"Segoe UI", ${DEFAULT_UI_FONT_STACK}` },
    { label: "Roboto", value: `Roboto, ${DEFAULT_UI_FONT_STACK}` },
    { label: "PingFang SC", value: `"PingFang SC", ${DEFAULT_UI_FONT_STACK}` },
    {
      label: "Microsoft YaHei",
      value: `"Microsoft YaHei", ${DEFAULT_UI_FONT_STACK}`,
    },
  ];
}

export function codeFontChoices(locale: Locale): FontChoice[] {
  const system = locale === "zh" ? "系统等宽" : "System monospace";
  return [
    { label: system, value: DEFAULT_CODE_FONT_STACK },
    {
      label: "JetBrains Mono",
      value: `"JetBrains Mono", ${DEFAULT_CODE_FONT_STACK}`,
    },
    { label: "Fira Code", value: `"Fira Code", ${DEFAULT_CODE_FONT_STACK}` },
    { label: "SF Mono", value: `"SF Mono", ${DEFAULT_CODE_FONT_STACK}` },
    { label: "Menlo", value: `Menlo, ${DEFAULT_CODE_FONT_STACK}` },
    { label: "Consolas", value: `Consolas, ${DEFAULT_CODE_FONT_STACK}` },
    {
      label: "Cascadia Code",
      value: `"Cascadia Code", ${DEFAULT_CODE_FONT_STACK}`,
    },
  ];
}

/**
 * A stored stack may not match any offered choice (set by hand or by an older
 * build), so the current value is surfaced as its own option instead of the
 * select silently falling back to the first entry.
 */
export function withCurrentFont(
  choices: FontChoice[],
  current: string,
): FontChoice[] {
  if (choices.some((choice) => choice.value === current)) {
    return choices;
  }
  return [{ label: primaryFontName(current), value: current }, ...choices];
}

/** The first family in a stack, unquoted, which is the part worth showing. */
function primaryFontName(stack: string): string {
  const first = stack.split(",")[0]?.trim() ?? stack;
  return first.replace(/^["']|["']$/g, "");
}
