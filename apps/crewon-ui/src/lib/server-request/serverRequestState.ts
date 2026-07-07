import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";

export function resolveServerRequestPanel(
  panel: CapabilityPanel | null,
  requestId: number | string,
  locale: Locale,
): CapabilityPanel | null {
  return panel?.subtitle === String(requestId)
    ? {
        ...panel,
        actions: undefined,
        fields: undefined,
        body: locale === "zh" ? "请求已处理" : "Request resolved",
      }
    : panel;
}

export function clearPendingRequestById<T extends { id: number | string }>(
  current: T | null,
  requestId: number | string,
): T | null {
  return String(current?.id) === String(requestId) ? null : current;
}
