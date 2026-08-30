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
          detail: "工作区内自动执行，必要时请求升级",
          label: "本地自动",
          value: "approve-for-me",
        },
        {
          detail: "涉及授权时先请求确认",
          label: "操作前确认",
          value: "request-approval",
        },
        {
          detail: "跳过沙箱与审批，可读写工作区外的文件并联网",
          label: "完全访问",
          tone: "warning",
          value: "full-access",
        },
      ]
    : [
        {
          detail: "Run automatically in the workspace and ask when needed",
          label: "Workspace access",
          value: "approve-for-me",
        },
        {
          detail: "Ask before operations that require approval",
          label: "Ask before actions",
          value: "request-approval",
        },
        {
          detail:
            "Skip the sandbox and approvals; can read and write outside the workspace and reach the network",
          label: "Full access",
          tone: "warning",
          value: "full-access",
        },
      ];
}
