import type { NoticeState } from "../shared/noticeState";
import type { LibraryPanel } from "../domain/crewonDomain";
import type { Locale } from "../i18n";

export function knowledgeResetDemoPatch(
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    body:
      locale === "zh"
        ? "全局记忆已重置（演示）。连接 app-server 后会调用 memory/reset，不会清空工作区知识文件。"
        : "Global memory reset (demo). With app-server connected this calls memory/reset and does not clear workspace knowledge files.",
    error: undefined,
  };
}

export function knowledgeResetDemoPanel(
  panel: LibraryPanel | null,
  locale: Locale,
): LibraryPanel | null {
  return patchKnowledgePanel(panel, knowledgeResetDemoPatch(locale));
}

export function knowledgeDisconnectedPatch(
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function knowledgeDisconnectedPanel(
  panel: LibraryPanel | null,
  locale: Locale,
): LibraryPanel | null {
  return patchKnowledgePanel(panel, knowledgeDisconnectedPatch(locale));
}

export function knowledgeResetConfirmMessage(locale: Locale): string {
  return locale === "zh"
    ? "重置全局记忆会清除模型可复用的记忆状态。继续？"
    : "Resetting memory clears reusable model memory state. Continue?";
}

export function knowledgeResetProgressPatch(
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    body: locale === "zh" ? "正在重置全局记忆..." : "Resetting global memory...",
    error: undefined,
  };
}

export function knowledgeResetProgressPanel(
  panel: LibraryPanel | null,
  locale: Locale,
): LibraryPanel | null {
  return patchKnowledgePanel(panel, knowledgeResetProgressPatch(locale));
}

export function knowledgeResetSuccessNotice(locale: Locale): NoticeState {
  return {
    text: locale === "zh" ? "全局记忆已重置" : "Global memory reset",
    tone: "success",
  };
}

export function knowledgeResetFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "重置全局记忆失败"
          : "Unable to reset global memory",
  };
}

export function knowledgeResetFailurePanel(
  panel: LibraryPanel | null,
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return patchKnowledgePanel(panel, knowledgeResetFailurePatch(error, locale));
}

export function knowledgeWriteProgressPatch(
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    body:
      locale === "zh"
        ? "正在写入工作区知识记忆..."
        : "Writing workspace knowledge memory...",
    error: undefined,
  };
}

export function knowledgeWriteProgressPanel(
  panel: LibraryPanel | null,
  locale: Locale,
): LibraryPanel | null {
  return patchKnowledgePanel(panel, knowledgeWriteProgressPatch(locale));
}

export function knowledgeWriteMissingWorkspacePatch(
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    error:
      locale === "zh"
        ? "当前没有工作区路径，无法写入知识库。"
        : "No workspace path is available for writing knowledge.",
  };
}

export function knowledgeWriteMissingWorkspacePanel(
  panel: LibraryPanel | null,
  locale: Locale,
): LibraryPanel | null {
  return patchKnowledgePanel(
    panel,
    knowledgeWriteMissingWorkspacePatch(locale),
  );
}

export function knowledgeWriteSuccessNotice(
  path: string,
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? `已写入知识库：${path}`
        : `Knowledge memory written: ${path}`,
    tone: "success",
  };
}

export function knowledgeWriteFailurePanel(
  panel: LibraryPanel | null,
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return patchKnowledgePanel(panel, knowledgeWriteFailurePatch(error, locale));
}

function patchKnowledgePanel(
  panel: LibraryPanel | null,
  patch: Partial<LibraryPanel>,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        ...patch,
      }
    : panel;
}

export function knowledgeWriteFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "写入知识库失败"
          : "Unable to write knowledge",
  };
}
