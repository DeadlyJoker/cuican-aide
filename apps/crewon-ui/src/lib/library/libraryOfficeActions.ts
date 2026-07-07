import type { NoticeState } from "../shared/noticeState";
import {
  type LibraryPanel,
  type LibraryPanelAction,
  type OfficeConfig,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  buildOfficeCreatePanel,
  officeCreateFailureNotice,
  officeCreateFailurePanel,
  officeCreateSubtitle,
  officeCreateTitle,
} from "../office/officeDetailPanel";
import { newDraftOfficeWorkspace } from "../office/officeWorkspace";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type LibraryOfficeActionParams = {
  action: LibraryPanelAction;
  createOfficeConfig: (params: {
    goal: string;
    subtitle: string;
    threadId?: string | null;
    title: string;
  }) => Promise<{ config: OfficeConfig; filePath: string } | null>;
  isUnsupportedRpcError: (error: unknown) => boolean;
  locale: Locale;
  now: () => Date;
  setLibraryPanel: ((panel: LibraryPanel | null) => void) & LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  writeOfficeConfig: (config: OfficeConfig) => Promise<string | null>;
};

export async function handleLibraryOfficeAction({
  action,
  createOfficeConfig,
  isUnsupportedRpcError,
  locale,
  now,
  setLibraryPanel,
  setNotice,
  writeOfficeConfig,
}: LibraryOfficeActionParams): Promise<boolean> {
  if (action.id !== "create-office") {
    return false;
  }

  try {
    const title = officeCreateTitle(
      now().toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      locale,
    );

    const subtitle = officeCreateSubtitle(locale);
    const workspace = newDraftOfficeWorkspace(title, locale);
    let officeConfigPath: string | null = null;
    let savedOfficeConfig: OfficeConfig = {
      title,
      subtitle,
      workspace,
    };
    try {
      const officeCreateResponse = await createOfficeConfig({
        title,
        subtitle,
        threadId: null,
        goal: workspace.goal,
      });
      if (officeCreateResponse) {
        officeConfigPath = officeCreateResponse.filePath;
        savedOfficeConfig = officeCreateResponse.config;
      } else {
        officeConfigPath = await writeOfficeConfig(savedOfficeConfig);
      }
    } catch (error) {
      if (!isUnsupportedRpcError(error)) {
        throw error;
      }
      officeConfigPath = await writeOfficeConfig(savedOfficeConfig);
    }

    setLibraryPanel(
      buildOfficeCreatePanel({
        configPath: officeConfigPath,
        locale,
        subtitle,
        title,
        workspace: savedOfficeConfig.workspace,
      }),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      officeCreateFailurePanel(currentPanel, error, locale),
    );
    setNotice(officeCreateFailureNotice(error, locale));
  }
  return true;
}
