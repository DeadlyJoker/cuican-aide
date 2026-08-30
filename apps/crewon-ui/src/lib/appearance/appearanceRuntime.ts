import { applyAppearanceToDocument } from "./applyAppearance";
import { appearanceWithField } from "./appearanceSerialization";
import {
  DEFAULT_APPEARANCE,
  type AppearancePreferences,
} from "./appearancePreferences";
import { detectOperatingSystem, detectRuntimeSurface } from "../platform";

/**
 * The appearance currently painted on the document. Settings commits need to
 * update a single field without re-reading config, so the applied state has one
 * owner instead of being recomputed from scratch at each call site.
 */
let applied: AppearancePreferences = DEFAULT_APPEARANCE;

export function appliedAppearance(): AppearancePreferences {
  return applied;
}

/** Applies a full preference set and records it as the live state. */
export function setAppliedAppearance(preferences: AppearancePreferences): void {
  applied = preferences;
  applyAppearanceToDocument({
    os: detectOperatingSystem(),
    preferences,
    surface: detectRuntimeSurface(),
  });
}

/**
 * Applies a single committed field on top of the live state, so a panel edit
 * shows up immediately rather than only after the next config read.
 */
export function applyAppearanceField(
  field: keyof AppearancePreferences,
  value: string,
): void {
  setAppliedAppearance(appearanceWithField(applied, field, value));
}
