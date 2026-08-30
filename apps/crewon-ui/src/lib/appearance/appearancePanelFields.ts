import {
  CODE_FONT_SIZE_RANGE,
  CONTRAST_RANGE,
  UI_FONT_SIZE_RANGE,
  supportsFontSmoothing,
  type AppearancePreferences,
} from "./appearancePreferences";
import {
  codeFontChoices,
  uiFontChoices,
  withCurrentFont,
} from "./appearanceFontChoices";
import type { CapabilityPanelField } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import type { OperatingSystem, RuntimeSurface } from "../platform";

/** Field ids double as the config binding key, so they stay stable. */
export const APPEARANCE_FIELD_IDS = {
  accent: "appearance-accent",
  background: "appearance-background",
  codeFontFamily: "appearance-code-font",
  codeFontSize: "appearance-code-font-size",
  contrast: "appearance-contrast",
  diffMarkers: "appearance-diff-markers",
  fontSmoothing: "appearance-font-smoothing",
  foreground: "appearance-foreground",
  locale: "appearance-locale",
  reduceMotion: "appearance-reduce-motion",
  themeMode: "appearance-theme",
  translucentSidebar: "appearance-translucent-sidebar",
  uiFontFamily: "appearance-ui-font",
  uiFontSize: "appearance-ui-font-size",
} as const;

function text(locale: Locale, zh: string, en: string): string {
  return locale === "zh" ? zh : en;
}

/**
 * Builds the appearance fields. Controls that cannot take effect on the current
 * platform are omitted rather than shown inert: font smoothing is macOS-only,
 * and a translucent sidebar needs a desktop window to blur against.
 */
export function appearancePanelFields(params: {
  locale: Locale;
  os: OperatingSystem;
  preferences: AppearancePreferences;
  surface: RuntimeSurface;
  uiLocale: string;
}): CapabilityPanelField[] {
  const { locale, os, preferences, surface, uiLocale } = params;
  const fields: CapabilityPanelField[] = [
    {
      commitOnChange: true,
      id: APPEARANCE_FIELD_IDS.locale,
      label: text(locale, "语言", "Language"),
      options: [
        { label: "中文", value: "zh" },
        { label: "English", value: "en" },
      ],
      value: uiLocale,
    },
    {
      commitOnChange: true,
      control: "segmented",
      id: APPEARANCE_FIELD_IDS.themeMode,
      label: text(locale, "主题", "Theme"),
      options: [
        { label: text(locale, "系统", "System"), value: "system" },
        { label: text(locale, "浅色", "Light"), value: "light" },
        { label: text(locale, "深色", "Dark"), value: "dark" },
      ],
      value: preferences.themeMode,
    },
    {
      commitOnChange: true,
      control: "color",
      id: APPEARANCE_FIELD_IDS.accent,
      label: text(locale, "强调色", "Accent"),
      value: preferences.accent,
    },
    {
      commitOnChange: true,
      control: "color",
      id: APPEARANCE_FIELD_IDS.background,
      label: text(locale, "背景", "Background"),
      value: preferences.background,
    },
    {
      commitOnChange: true,
      control: "color",
      id: APPEARANCE_FIELD_IDS.foreground,
      label: text(locale, "前景", "Foreground"),
      value: preferences.foreground,
    },
    {
      commitOnChange: true,
      id: APPEARANCE_FIELD_IDS.uiFontFamily,
      label: text(locale, "UI 字体", "UI font"),
      options: withCurrentFont(uiFontChoices(locale), preferences.uiFontFamily),
      value: preferences.uiFontFamily,
    },
    {
      commitOnChange: true,
      id: APPEARANCE_FIELD_IDS.codeFontFamily,
      label: text(locale, "代码字体", "Code font"),
      options: withCurrentFont(
        codeFontChoices(locale),
        preferences.codeFontFamily,
      ),
      value: preferences.codeFontFamily,
    },
    {
      commitOnChange: true,
      control: "number",
      description: text(
        locale,
        "调整界面使用的基准字号",
        "Base font size for the interface",
      ),
      id: APPEARANCE_FIELD_IDS.uiFontSize,
      label: text(locale, "UI 字号", "UI font size"),
      max: UI_FONT_SIZE_RANGE.max,
      min: UI_FONT_SIZE_RANGE.min,
      unit: "px",
      value: String(preferences.uiFontSize),
    },
    {
      commitOnChange: true,
      control: "number",
      description: text(
        locale,
        "调整任务和差异对比中代码的基准字号",
        "Base font size for code and diffs",
      ),
      id: APPEARANCE_FIELD_IDS.codeFontSize,
      label: text(locale, "代码字体大小", "Code font size"),
      max: CODE_FONT_SIZE_RANGE.max,
      min: CODE_FONT_SIZE_RANGE.min,
      unit: "px",
      value: String(preferences.codeFontSize),
    },
    {
      commitOnChange: true,
      control: "slider",
      description: text(
        locale,
        "提高次要文字与背景的对比",
        "Raises contrast for secondary text",
      ),
      id: APPEARANCE_FIELD_IDS.contrast,
      label: text(locale, "对比度", "Contrast"),
      max: CONTRAST_RANGE.max,
      min: CONTRAST_RANGE.min,
      value: String(preferences.contrast),
    },
    {
      commitOnChange: true,
      control: "segmented",
      description: text(
        locale,
        "减少动画效果或匹配系统设置",
        "Reduce animations or match the system setting",
      ),
      id: APPEARANCE_FIELD_IDS.reduceMotion,
      label: text(locale, "减少动态效果", "Reduce motion"),
      options: [
        { label: text(locale, "系统", "System"), value: "system" },
        { label: text(locale, "开启", "On"), value: "on" },
        { label: text(locale, "关闭", "Off"), value: "off" },
      ],
      value: preferences.reduceMotion,
    },
    {
      commitOnChange: true,
      control: "segmented",
      description: text(
        locale,
        "使用颜色或 +/- 标记显示变更",
        "Show changes with color or +/- signs",
      ),
      id: APPEARANCE_FIELD_IDS.diffMarkers,
      label: text(locale, "差异标记", "Diff markers"),
      options: [
        { label: text(locale, "颜色", "Color"), value: "color" },
        { label: "+/-", value: "sign" },
      ],
      value: preferences.diffMarkers,
    },
  ];

  if (surface === "desktop") {
    fields.push({
      commitOnChange: true,
      control: "toggle",
      description: text(
        locale,
        "侧边栏透出桌面窗口背景",
        "Let the sidebar blur the window background",
      ),
      id: APPEARANCE_FIELD_IDS.translucentSidebar,
      label: text(locale, "半透明侧边栏", "Translucent sidebar"),
      value: String(preferences.translucentSidebar),
    });
  }

  if (supportsFontSmoothing(os)) {
    fields.push({
      commitOnChange: true,
      control: "toggle",
      description: text(
        locale,
        "使用 macOS 原生字体抗锯齿",
        "Use native macOS font antialiasing",
      ),
      id: APPEARANCE_FIELD_IDS.fontSmoothing,
      label: text(locale, "字体平滑", "Font smoothing"),
      value: String(preferences.fontSmoothing),
    });
  }

  return fields;
}
