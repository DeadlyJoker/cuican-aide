import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import { filePanelSearchControls } from "../capability/capabilityPanelText";
import type { Locale } from "../i18n";
import { patchPanelState } from "../shared/panelState";

export type FileWatchAction = "unwatch" | "watch";

export function fileCopyDestinationPath(sourcePath: string): string {
  return `${sourcePath.replace(/[\\/]+$/, "")}.copy`;
}

export function fileCopyProgressBody(locale: Locale): string {
  return locale === "zh" ? "正在复制..." : "Copying...";
}

export function fileCopyProgressPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: fileCopyProgressBody(locale),
    error: undefined,
  };
}

export function fileCopyProgressPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, fileCopyProgressPatch(locale));
}

export function fileCopyBodyPrefix(
  destinationPath: string,
  locale: Locale,
): string {
  return locale === "zh"
    ? `已复制到：${destinationPath}`
    : `Copied to: ${destinationPath}`;
}

export function fileCopyNotice(
  destinationPath: string,
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? `已复制：${destinationPath}`
        : `Copied: ${destinationPath}`,
    tone: "success",
  };
}

export function fileCopyFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "复制失败"
      : "Unable to copy";
}

export function fileCopyFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: fileCopyFailureMessage(error, locale),
  };
}

export function fileCopyFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, fileCopyFailurePatch(error, locale));
}

export function fileSearchProgressBody(locale: Locale): string {
  return locale === "zh" ? "正在搜索..." : "Searching...";
}

export function fileSearchProgressPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: fileSearchProgressBody(locale),
    error: undefined,
  };
}

export function fileSearchProgressPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, fileSearchProgressPatch(locale));
}

export function contextNoteProgressBody(locale: Locale): string {
  return locale === "zh"
    ? "正在创建上下文笔记..."
    : "Creating context note...";
}

export function contextNoteProgressPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: contextNoteProgressBody(locale),
    error: undefined,
  };
}

export function contextNoteProgressPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, contextNoteProgressPatch(locale));
}

export function contextNoteBody(params: {
  createdAtIso: string;
  locale: Locale;
  root: string;
}): string {
  const { createdAtIso, locale, root } = params;
  return [
    `# ${locale === "zh" ? "上下文笔记" : "Context note"}`,
    "",
    `- ${locale === "zh" ? "创建时间" : "Created"}: ${createdAtIso}`,
    `- ${locale === "zh" ? "工作区" : "Workspace"}: ${root}`,
    `- ${locale === "zh" ? "来源" : "Source"}: Crewon files panel`,
    "",
    locale === "zh"
      ? "这里记录给智能体、办公室或自动化复用的项目上下文。"
      : "Record reusable project context for agents, offices, or automations here.",
    "",
  ].join("\n");
}

export function contextNotePanel(params: {
  locale: Locale;
  metadataText: string;
  noteBody: string;
  notePath: string;
  root: string;
}): CapabilityPanel {
  const { locale, metadataText, noteBody, notePath, root } = params;
  return {
    title: locale === "zh" ? "上下文笔记" : "Context note",
    subtitle: notePath,
    body: [metadataText, noteBody].filter(Boolean).join("\n\n"),
    ...filePanelSearchControls(locale, root),
  };
}

export function contextNoteCreatedNotice(
  notePath: string,
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? `已创建上下文笔记：${notePath}`
        : `Context note created: ${notePath}`,
    tone: "success",
  };
}

export function contextNoteFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "创建上下文笔记失败"
      : "Unable to create context note";
}

export function contextNoteFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: contextNoteFailureMessage(error, locale),
  };
}

export function contextNoteFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, contextNoteFailurePatch(error, locale));
}

export function sendContextProgressBody(locale: Locale): string {
  return locale === "zh"
    ? "正在发送上下文到后端会话..."
    : "Sending context to backend thread...";
}

export function sendContextProgressPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: sendContextProgressBody(locale),
    error: undefined,
  };
}

export function sendContextProgressPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, sendContextProgressPatch(locale));
}

export function contextThreadTitle(path: string, locale: Locale): string {
  return locale === "zh"
    ? `读取工作区上下文：${path}`
    : `Read workspace context: ${path}`;
}

export function sendContextSuccessBody(
  threadTitleText: string,
  locale: Locale,
): string {
  return locale === "zh"
    ? `已发送到后端会话：${threadTitleText}`
    : `Sent to backend thread: ${threadTitleText}`;
}

export function sendContextSuccessPatch(
  threadTitleText: string,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: sendContextSuccessBody(threadTitleText, locale),
    error: undefined,
  };
}

export function sendContextSuccessPanel(
  panel: CapabilityPanel | null,
  threadTitleText: string,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, sendContextSuccessPatch(threadTitleText, locale));
}

export function sendContextNotice(locale: Locale): NoticeState {
  return {
    text:
      locale === "zh"
        ? "上下文文件已发送到后端会话"
        : "Context file sent to backend thread",
    tone: "success",
  };
}

export function sendContextFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "发送上下文失败"
      : "Unable to send context";
}

export function sendContextFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: sendContextFailureMessage(error, locale),
  };
}

export function sendContextFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, sendContextFailurePatch(error, locale));
}

export function fileWatchDemoBody(locale: Locale): string {
  return locale === "zh"
    ? "文件监听已更新（演示）。连接 app-server 后会调用 fs/watch 或 fs/unwatch。"
    : "File watch updated (demo). With app-server connected this calls fs/watch or fs/unwatch.";
}

export function fileWatchDemoPatch(locale: Locale): Partial<CapabilityPanel> {
  return {
    body: fileWatchDemoBody(locale),
    error: undefined,
  };
}

export function fileWatchDemoPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, fileWatchDemoPatch(locale));
}

export function fileWatchProgressBody(
  action: FileWatchAction,
  locale: Locale,
): string {
  if (action === "watch") {
    return locale === "zh" ? "正在启动文件监听..." : "Starting file watch...";
  }
  return locale === "zh" ? "正在停止文件监听..." : "Stopping file watch...";
}

export function fileWatchProgressPatch(
  action: FileWatchAction,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: fileWatchProgressBody(action, locale),
    error: undefined,
  };
}

export function fileWatchProgressPanel(
  panel: CapabilityPanel | null,
  action: FileWatchAction,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, fileWatchProgressPatch(action, locale));
}

export function fileWatchNoActiveBody(locale: Locale): string {
  return locale === "zh"
    ? "当前没有运行中的文件监听。"
    : "No file watch is currently running.";
}

export function fileWatchNoActivePatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: fileWatchNoActiveBody(locale),
    error: undefined,
  };
}

export function fileWatchNoActivePanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, fileWatchNoActivePatch(locale));
}

export function fileWatchStoppedBody(path: string, locale: Locale): string {
  return locale === "zh" ? `已停止监听：${path}` : `Stopped watching: ${path}`;
}

export function fileWatchStoppedPatch(
  path: string,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: fileWatchStoppedBody(path, locale),
    error: undefined,
  };
}

export function fileWatchStoppedPanel(
  panel: CapabilityPanel | null,
  path: string,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, fileWatchStoppedPatch(path, locale));
}

export function fileWatchStartedBody(path: string, locale: Locale): string {
  return locale === "zh" ? `正在监听：${path}` : `Watching: ${path}`;
}

export function fileWatchStartedPatch(
  path: string,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: fileWatchStartedBody(path, locale),
    error: undefined,
  };
}

export function fileWatchStartedPanel(
  panel: CapabilityPanel | null,
  path: string,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, fileWatchStartedPatch(path, locale));
}

export function fileWatchFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "文件监听操作失败"
      : "File watch action failed";
}

export function fileWatchFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: fileWatchFailureMessage(error, locale),
  };
}

export function fileWatchFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, fileWatchFailurePatch(error, locale));
}
