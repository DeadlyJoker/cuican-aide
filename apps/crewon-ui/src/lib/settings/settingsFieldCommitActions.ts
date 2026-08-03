import type { JsonValue } from "@crewon-protocol/serde_json/JsonValue";

import { appearanceFieldPreference } from "../appearance/appearanceFieldBinding";
import {
  DEFAULT_APPEARANCE,
  type AppearancePreferences,
} from "../appearance/appearancePreferences";
import { appearanceWithField } from "../appearance/appearanceSerialization";
import type { Locale } from "../i18n";
import type { Theme } from "../theme";
import { settingsConfigField } from "./settingsCatalog";

export type SettingsFieldCommitOutcome = {
  /** True when the stored value differs from what the user typed, so the
   * caller knows the panel has to be re-read to show what took effect. */
  normalized: boolean;
};

type AppearanceField = keyof AppearancePreferences;

/**
 * Runs a committed value through the appearance parser so what gets persisted
 * is the value that will actually take effect. Clamping and rejection rules
 * live in one place rather than being restated here.
 */
function normalizedAppearanceValue(
  field: AppearanceField,
  value: string,
): string {
  const parsed = appearanceWithField(DEFAULT_APPEARANCE, field, value);
  return String(parsed[field]);
}

type SettingsFieldCommitClient = {
  writeConfigBatch(
    edits: Array<{
      keyPath: string;
      mergeStrategy?: "upsert";
      value: JsonValue;
    }>,
  ): Promise<unknown>;
};

export async function commitSettingsFieldAction(params: {
  /** Applies an appearance field to the live document; injected for tests. */
  applyAppearanceField?: (field: AppearanceField, value: string) => void;
  client: SettingsFieldCommitClient | null | undefined;
  fieldId: string;
  isConnected: boolean;
  persistLocale: (locale: Locale) => void;
  persistTheme: (theme: Theme) => void;
  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
  systemPrefersDark?: boolean;
  value: string;
}): Promise<SettingsFieldCommitOutcome> {
  const field = settingsConfigField(params.fieldId);
  if (!field) {
    throw new Error(`Unsupported settings field: ${params.fieldId}`);
  }

  if (params.fieldId === "appearance-locale") {
    if (params.value !== "zh" && params.value !== "en") {
      throw new Error(`Unsupported locale: ${params.value}`);
    }
    params.setLocale(params.value);
    params.persistLocale(params.value);
  }

  if (params.fieldId === "appearance-theme") {
    // "system" defers to the OS preference, so resolve it before applying.
    const resolved =
      params.value === "system"
        ? params.systemPrefersDark
          ? "dark"
          : "light"
        : params.value;
    if (resolved !== "light" && resolved !== "dark") {
      throw new Error(`Unsupported theme: ${params.value}`);
    }
    params.setTheme(resolved);
    params.persistTheme(resolved);
  }

  /*
   * Colors, fonts, and behavior flags only live in CSS, so they are applied to
   * the document here rather than routed through React state. The value is
   * normalized first: typing 999 into a 10..18 field must persist and display
   * the clamped 18, not leave the panel showing a number that is not in effect.
   */
  const appearanceField = appearanceFieldPreference(params.fieldId);
  const value = appearanceField
    ? normalizedAppearanceValue(appearanceField, params.value)
    : params.value;
  if (appearanceField) {
    params.applyAppearanceField?.(appearanceField, value);
  }

  if (!params.client || !params.isConnected) {
    throw new Error("Local app-server is not connected");
  }

  await params.client.writeConfigBatch([
    {
      keyPath: field.configPath,
      mergeStrategy: "upsert",
      value,
    },
  ]);

  return { normalized: value !== params.value };
}
