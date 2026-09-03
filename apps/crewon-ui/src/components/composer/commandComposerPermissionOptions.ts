import type { Locale } from "../../lib/i18n";
import type { CommandComposerPermission } from "../../lib/thread/threadRuntimeSettings";
import type { CommandComposerSelectOption } from "./CommandComposer";

/**
 * Permission presets for the composer. Extracted from CommandWorkspace so the
 * tone mapping (full access is a warning) stays directly testable — the select
 * menu itself only renders while open, so static markup can no longer see it.
 */
export function commandComposerPermissionOptions(
  locale: Locale,
): CommandComposerSelectOption<CommandComposerPermission>[] {
  return locale === "zh"
    ? [
        {
          detail: "编辑外部文件和使用互联网时始终询问",
          icon: "hand",
          label: "请求批准",
          triggerLabel: "请求批准",
          value: "request-approval",
        },
        {
          detail: "仅对检测到的风险操作请求批准",
          icon: "shield-check",
          label: "帮我批准",
          triggerLabel: "帮我批准",
          value: "approve-for-me",
        },
        {
          detail: "可不受限制地访问互联网和你电脑上的任何文件",
          icon: "shield-alert",
          label: "完全访问权限",
          tone: "warning",
          triggerLabel: "完全访问",
          value: "full-access",
        },
      ]
    : [
        {
          detail: "Always ask before editing outside the workspace or using the internet",
          icon: "hand",
          label: "Ask for approval",
          triggerLabel: "Ask for approval",
          value: "request-approval",
        },
        {
          detail: "Ask only for detected risky operations",
          icon: "shield-check",
          label: "Approve for me",
          triggerLabel: "Approve for me",
          value: "approve-for-me",
        },
        {
          detail: "Unrestricted access to the internet and any file on your computer",
          icon: "shield-alert",
          label: "Full access",
          tone: "warning",
          triggerLabel: "Full access",
          value: "full-access",
        },
      ];
}

export function commandComposerPermissionMenuTitle(locale: Locale): string {
  return locale === "zh"
    ? "应如何批准 ChatGPT 操作？"
    : "How should ChatGPT actions be approved?";
}

export const commandComposerPermissionLearnMoreUrl =
  "https://developers.openai.com/codex/concepts/sandboxing#how-you-control-it";

export function commandComposerPermissionLearnMoreLabel(locale: Locale): string {
  return locale === "zh" ? "了解更多" : "Learn more";
}
