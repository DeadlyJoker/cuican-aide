export const PERSONALIZATION_SETTINGS_STORAGE_KEY =
  "crewon:personalization-settings:v1";

const MAX_INSTRUCTIONS_BYTES = 9_999;

export type PersonalizationMemoryMode =
  | "learn-only"
  | "off"
  | "on"
  | "read-only";

export type PersonalizationSettings = Readonly<{
  developerInstructions: string;
  instructions: string;
  memoryMode: PersonalizationMemoryMode;
}>;

export interface PersonalizationSettingsStore {
  read(): PersonalizationSettings;
  write(settings: PersonalizationSettings): void;
}

export const defaultPersonalizationSettings: PersonalizationSettings = {
  developerInstructions: "",
  instructions: "",
  memoryMode: "off",
};

export function browserPersonalizationSettingsStore(
  storage: Pick<Storage, "getItem" | "setItem"> | null = browserStorage(),
): PersonalizationSettingsStore | null {
  if (storage === null) return null;
  return {
    read: () => readPersonalizationSettings(storage),
    write: (settings) => writePersonalizationSettings(settings, storage),
  };
}

export function personalizationSettingsFromFields(
  fieldValue: (fieldId: string) => string,
): PersonalizationSettings {
  return parsePersonalizationSettings({
    developerInstructions: fieldValue("personalization-developer-instructions"),
    instructions: fieldValue("personalization-instructions"),
    memoryMode: fieldValue("personalization-memory-mode"),
  });
}

export function readPersonalizationSettings(
  storage: Pick<Storage, "getItem">,
): PersonalizationSettings {
  try {
    const value = storage.getItem(PERSONALIZATION_SETTINGS_STORAGE_KEY);
    return value === null
      ? defaultPersonalizationSettings
      : parsePersonalizationSettings(JSON.parse(value));
  } catch {
    return defaultPersonalizationSettings;
  }
}

export function writePersonalizationSettings(
  settings: PersonalizationSettings,
  storage: Pick<Storage, "setItem">,
): void {
  storage.setItem(
    PERSONALIZATION_SETTINGS_STORAGE_KEY,
    JSON.stringify(parsePersonalizationSettings(settings)),
  );
}

/**
 * Builds the bounded preference fragment attached to Control assistant turns.
 * It is deliberately framed as user-owned preferences rather than pretending
 * renderer state has system-message authority.
 */
export function personalizationContext(
  settings: PersonalizationSettings,
): string {
  const lines = [
    settings.instructions ? `角色定位：\n${settings.instructions}` : null,
    settings.developerInstructions
      ? `长期行为原则：\n${settings.developerInstructions}`
      : null,
    settings.memoryMode === "on"
      ? "长期记忆偏好：允许在有可用且受治理的记忆能力时生成并使用记忆；没有该能力时不要声称已经记住。"
      : settings.memoryMode === "read-only"
        ? "长期记忆偏好：只使用已有且受治理的记忆，不生成新记忆。"
        : settings.memoryMode === "learn-only"
          ? "长期记忆偏好：允许生成受治理的记忆，但不要主动检索已有记忆。"
          : null,
  ].filter((line): line is string => line !== null);
  return lines.join("\n\n");
}

function parsePersonalizationSettings(value: unknown): PersonalizationSettings {
  if (typeof value !== "object" || value === null) {
    throw new Error("personalization_settings_invalid");
  }
  const candidate = value as Partial<
    Record<keyof PersonalizationSettings, unknown>
  >;
  return {
    developerInstructions: boundedText(candidate.developerInstructions),
    instructions: boundedText(candidate.instructions),
    memoryMode: memoryMode(candidate.memoryMode),
  };
}

function boundedText(value: unknown): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > MAX_INSTRUCTIONS_BYTES
  ) {
    throw new Error("personalization_settings_invalid");
  }
  return value;
}

function memoryMode(value: unknown): PersonalizationMemoryMode {
  if (
    value === "learn-only" ||
    value === "off" ||
    value === "on" ||
    value === "read-only"
  ) {
    return value;
  }
  throw new Error("personalization_settings_invalid");
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
