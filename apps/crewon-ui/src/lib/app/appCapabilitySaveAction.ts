import { saveCapabilityEditorDraft } from "../capability/capabilityEditorSave";
import type { AppServerClient } from "../app-server/appServer";
import type { CapabilityEditorDraft } from "../capability/capabilityCatalog";
import type { Locale } from "../i18n";
import type { NoticeState } from "../shared/noticeState";

type SavedCapability = Awaited<ReturnType<typeof saveCapabilityEditorDraft>>;

/**
 * Saves a capability draft and reports the result.
 *
 * The editor only supplies a draft; requiring a live connection, resolving the
 * workspace directory, and phrasing the confirmation notice are coordination
 * concerns that stay out of the app shell.
 */
export async function saveCapabilityDraftAction(params: {
  client: AppServerClient | null;
  draft: CapabilityEditorDraft;
  locale: Locale;
  resolveBackendCwd: () => Promise<string | null>;
  setNotice: (notice: NoticeState) => void;
}): Promise<SavedCapability> {
  const capabilityCwd = await params.resolveBackendCwd();
  if (!params.client || !capabilityCwd) {
    throw new Error("App Server 未连接，无法保存能力");
  }
  const saved = await saveCapabilityEditorDraft({
    client: params.client,
    cwd: capabilityCwd,
    draft: params.draft,
    locale: params.locale,
  });
  params.setNotice({
    text: `已保存${saved.kind === "skill" ? "技能" : "服务"}：${saved.name}`,
    tone: "success",
  });
  return saved;
}
