import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import { fileChangedPanelAppendText } from "./appNotificationPresentation";

export { removeRecordKey } from "../shared/recordState";
export {
  activeTurnByThreadAfterTurn,
  activeTurnByThreadAfterTurnId,
  appendThreadText,
  clearThreadText,
} from "../thread/threadRuntimeState";
export {
  clearPendingRequestById,
  resolveServerRequestPanel,
} from "../server-request/serverRequestState";

export function appendFileChangesToPanel(
  panel: CapabilityPanel | null,
  changedPaths: string[],
  locale: Locale,
): CapabilityPanel | null {
  const filesTitle = locale === "zh" ? "文件" : "Files";
  return panel?.title === filesTitle
    ? {
        ...panel,
        body: [panel.body, fileChangedPanelAppendText(changedPaths, locale)]
          .filter(Boolean)
          .join("\n\n"),
        error: undefined,
      }
    : panel;
}
