import type { LibraryItemAction, LibraryPanel } from "../domain/crewonDomain";
import {
  buildMcpDraftPanelContent,
  buildSkillDraftPanelContent,
} from "../draft/draftSavePayloads";
import type { Locale } from "../i18n";
import { capabilityPresetById } from "./capabilityCatalog";

type CapabilityPresetAction = Extract<
  LibraryItemAction,
  { type: "capability-preset" }
>;

export function openCapabilityPresetAction(params: {
  action: CapabilityPresetAction;
  locale: Locale;
  setLibraryPanel: (
    updater: (panel: LibraryPanel | null) => LibraryPanel | null,
  ) => void;
}): boolean {
  const { action, locale, setLibraryPanel } = params;
  const preset = capabilityPresetById(action.presetId, action.presetKind);
  if (!preset) {
    return false;
  }

  const content =
    preset.kind === "mcp"
      ? buildMcpDraftPanelContent({
          config: preset.config,
          description:
            locale === "zh" ? preset.description : preset.descriptionEn,
          locale,
          serverName: preset.id,
          sourceUrl: preset.sourceUrl,
        })
      : buildSkillDraftPanelContent({
          cwd: locale === "zh" ? "当前工作空间" : "Current workspace",
          description:
            locale === "zh" ? preset.description : preset.descriptionEn,
          locale,
          skillName: preset.id,
          workflow: preset.workflow,
        });

  setLibraryPanel((panel) =>
    panel ? { ...panel, ...content } : { kind: "tools", ...content },
  );
  return true;
}
