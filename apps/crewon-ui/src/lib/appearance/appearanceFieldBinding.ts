import { APPEARANCE_FIELD_IDS } from "./appearancePanelFields";
import type { AppearancePreferences } from "./appearancePreferences";

/**
 * Maps a settings field id back to the preference it edits. Commit handlers use
 * this to apply a change to the live document instead of waiting for a reload,
 * so the panel previews exactly what was persisted.
 */
const FIELD_TO_PREFERENCE = new Map<string, keyof AppearancePreferences>(
  Object.entries(APPEARANCE_FIELD_IDS)
    .filter(([field]) => field !== "locale")
    .map(([field, id]) => [id, field as keyof AppearancePreferences]),
);

export function appearanceFieldPreference(
  fieldId: string,
): keyof AppearancePreferences | undefined {
  return FIELD_TO_PREFERENCE.get(fieldId);
}
