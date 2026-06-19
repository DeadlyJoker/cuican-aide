import type { NoticeState } from "../shared/noticeState";
import type { LibraryKind, LibraryPanelAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { skillToggleNoticeState } from "./libraryActionPresentation";

type SkillToolRecordSummary = { filePath: string } | null;

export type LibrarySkillActionParams = {
  action: LibraryPanelAction;
  locale: Locale;
  openLibrary: (kind: LibraryKind) => Promise<void>;
  resolveBackendCwd: () => Promise<string | null>;
  setNotice: (notice: NoticeState | null) => void;
  syncSkillToolConfig: (
    cwd: string,
    action: LibraryPanelAction,
    enabled: boolean,
    locale: Locale,
  ) => Promise<SkillToolRecordSummary>;
  writeSkillConfig: (params: {
    path?: string | null;
    name?: string | null;
    enabled: boolean;
  }) => Promise<unknown>;
};

export async function handleLibrarySkillAction({
  action,
  locale,
  openLibrary,
  resolveBackendCwd,
  setNotice,
  syncSkillToolConfig,
  writeSkillConfig,
}: LibrarySkillActionParams): Promise<boolean> {
  if (action.id !== "toggle-skill") {
    return false;
  }

  const nextEnabled = !action.skillEnabled;
  await writeSkillConfig({
    path: action.skillPath ?? null,
    name: action.skillPath ? null : (action.skillName ?? null),
    enabled: nextEnabled,
  });
  const toolCwd = await resolveBackendCwd();
  const syncedToolRecord = toolCwd
    ? await syncSkillToolConfig(toolCwd, action, nextEnabled, locale)
    : null;
  setNotice(
    skillToggleNoticeState({
      skillName: action.skillName,
      wasEnabled: action.skillEnabled,
      syncedToolRecord,
      locale,
    }),
  );
  await openLibrary("tools");
  return true;
}
