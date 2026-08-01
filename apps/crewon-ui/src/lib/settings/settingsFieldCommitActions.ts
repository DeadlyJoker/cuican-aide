import type { JsonValue } from "@crewon-protocol/serde_json/JsonValue";

import type { Locale } from "../i18n";
import type { Theme } from "../theme";
import { settingsConfigField } from "./settingsCatalog";

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
  client: SettingsFieldCommitClient | null | undefined;
  fieldId: string;
  isConnected: boolean;
  persistLocale: (locale: Locale) => void;
  persistTheme: (theme: Theme) => void;
  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
  value: string;
}): Promise<void> {
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
    if (params.value !== "light" && params.value !== "dark") {
      throw new Error(`Unsupported theme: ${params.value}`);
    }
    params.setTheme(params.value);
    params.persistTheme(params.value);
  }

  if (!params.client || !params.isConnected) {
    throw new Error("Local app-server is not connected");
  }

  await params.client.writeConfigBatch([
    {
      keyPath: field.configPath,
      mergeStrategy: "upsert",
      value: params.value,
    },
  ]);
}
