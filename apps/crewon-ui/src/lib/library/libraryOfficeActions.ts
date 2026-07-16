import type { NoticeState } from "../shared/noticeState";
import type { LibraryPanelAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";

export type LibraryOfficeActionParams = {
  action: LibraryPanelAction;
  locale: Locale;
  setNotice: (notice: NoticeState | null) => void;
};

export async function handleLibraryOfficeAction({
  action,
  locale,
  setNotice,
}: LibraryOfficeActionParams): Promise<boolean> {
  if (action.id !== "create-office") {
    return false;
  }
  setNotice({
    text:
      locale === "zh"
        ? "请在团队页创建办公室并填写真实名称、目标和成员；旧版快捷创建已停用。"
        : "Create the Office from Team with a real name, goal, and members; legacy quick-create is disabled.",
    tone: "warning",
  });
  return true;
}
