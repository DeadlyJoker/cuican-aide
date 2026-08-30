import { describe, expect, it } from "vitest";

import {
  PERSONALIZATION_SETTINGS_STORAGE_KEY,
  browserPersonalizationSettingsStore,
  defaultPersonalizationSettings,
  personalizationContext,
  personalizationSettingsFromFields,
  readPersonalizationSettings,
} from "./personalizationSettingsStore";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) =>
      key === PERSONALIZATION_SETTINGS_STORAGE_KEY ? value : null,
    setItem: (key: string, next: string) => {
      if (key === PERSONALIZATION_SETTINGS_STORAGE_KEY) value = next;
    },
  };
}

describe("personalization settings store", () => {
  it("round-trips the recommended memory mode without resetting it", () => {
    const storage = memoryStorage();
    const store = browserPersonalizationSettingsStore(storage);
    const settings = personalizationSettingsFromFields(
      (fieldId) =>
        ({
          "personalization-developer-instructions": "Use verified evidence.",
          "personalization-instructions": "Product and engineering assistant",
          "personalization-memory-mode": "on",
        })[fieldId] ?? "",
    );

    store?.write(settings);

    expect(store?.read()).toEqual(settings);
  });

  it("falls back safely when persisted data is malformed", () => {
    expect(readPersonalizationSettings(memoryStorage("{broken"))).toEqual(
      defaultPersonalizationSettings,
    );
  });

  it("frames stored preferences without claiming unavailable memory", () => {
    expect(
      personalizationContext({
        developerInstructions: "Be precise.",
        instructions: "Act as my operations assistant.",
        memoryMode: "on",
      }),
    ).toContain("没有该能力时不要声称已经记住");
  });
});
