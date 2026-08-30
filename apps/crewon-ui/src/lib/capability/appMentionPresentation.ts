import type { AppMentionInfo } from "../shared/composerMentions";
import type { Locale } from "../i18n";
import { patchPanelState } from "../shared/panelState";
import type { CapabilityPanel } from "./capabilityPanelTypes";

export function appMentionAddedPatch(
  mention: AppMentionInfo,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body:
      locale === "zh"
        ? `${mention.token} 已加入输入框。发送后会通过 turn/start 携带 app mention：${mention.path}`
        : `${mention.token} added to the composer. Sending will include the app mention through turn/start: ${mention.path}`,
    error: undefined,
  };
}

export function appMentionAddedPanel(
  panel: CapabilityPanel | null,
  mention: AppMentionInfo,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, appMentionAddedPatch(mention, locale));
}
