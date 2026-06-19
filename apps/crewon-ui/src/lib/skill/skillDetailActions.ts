import type { FsReadFileResponse } from "@crewon-protocol/v2/FsReadFileResponse";
import type { PluginSkillReadResponse } from "@crewon-protocol/v2/PluginSkillReadResponse";

import type { LibraryItemAction, LibraryPanel } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  pluginSkillDetailPanel,
  skillDetailFailurePanel,
  skillDetailLoadingPanel,
  skillFileDetailPanel,
} from "../library/libraryActionPresentation";
import { decodeBase64Text } from "../server-request/serverRequestPresentation";

type SkillFileAction = Extract<LibraryItemAction, { type: "skill-file" }>;
type PluginSkillAction = Extract<LibraryItemAction, { type: "plugin-skill" }>;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type OpenSkillFileDetailActionParams = {
  action: SkillFileAction;
  locale: Locale;
  readFile: (path: string) => Promise<FsReadFileResponse | null | undefined>;
  setLibraryPanel: LibraryPanelSetter;
};

export async function openSkillFileDetailAction({
  action,
  locale,
  readFile,
  setLibraryPanel,
}: OpenSkillFileDetailActionParams): Promise<boolean> {
  setLibraryPanel((currentPanel) =>
    skillDetailLoadingPanel(currentPanel, locale),
  );

  try {
    const response = await readFile(action.path);
    if (!response) {
      return true;
    }

    setLibraryPanel((currentPanel) =>
      skillFileDetailPanel(currentPanel, {
        action,
        body: decodeBase64Text(response.dataBase64),
        locale,
      }),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      skillDetailFailurePanel(currentPanel, error, locale),
    );
  }
  return true;
}

export type OpenPluginSkillDetailActionParams = {
  action: PluginSkillAction;
  fallbackTitle: string;
  locale: Locale;
  readPluginSkill: (
    remoteMarketplaceName: string,
    remotePluginId: string,
    skillName: string,
  ) => Promise<PluginSkillReadResponse | null | undefined>;
  setLibraryPanel: LibraryPanelSetter;
};

export async function openPluginSkillDetailAction({
  action,
  fallbackTitle,
  locale,
  readPluginSkill,
  setLibraryPanel,
}: OpenPluginSkillDetailActionParams): Promise<boolean> {
  setLibraryPanel((currentPanel) =>
    skillDetailLoadingPanel(currentPanel, locale),
  );

  try {
    const response = await readPluginSkill(
      action.remoteMarketplaceName,
      action.remotePluginId,
      action.skillName,
    );

    setLibraryPanel((currentPanel) =>
      pluginSkillDetailPanel(currentPanel, {
        action,
        contents: response?.contents,
        fallbackTitle,
        locale,
      }),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      skillDetailFailurePanel(currentPanel, error, locale),
    );
  }
  return true;
}
