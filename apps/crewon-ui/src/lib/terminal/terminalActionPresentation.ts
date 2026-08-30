import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import { patchPanelState, updatePanelFieldValue } from "../shared/panelState";

export function backgroundTerminalsDemoBody(locale: Locale): string {
  return locale === "zh"
    ? "演示模式下没有后台终端。连接 app-server 后会读取真实会话后台任务。"
    : "Demo mode has no background terminals. Connect app-server to read real session tasks.";
}

export function backgroundTerminalsDemoPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: backgroundTerminalsDemoBody(locale),
    error: undefined,
  };
}

export function backgroundTerminalsDemoPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, backgroundTerminalsDemoPatch(locale));
}

export function backgroundTerminalActionFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "后台终端操作失败"
      : "Background terminal action failed";
}

export function backgroundTerminalActionFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: backgroundTerminalActionFailureMessage(error, locale),
  };
}

export function backgroundTerminalActionFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(
    panel,
    backgroundTerminalActionFailurePatch(error, locale),
  );
}

export function backgroundTerminalTerminateConfirmMessage(
  processId: string,
  locale: Locale,
): string {
  return locale === "zh"
    ? `终止后台进程：${processId}`
    : `Terminate background process: ${processId}`;
}

export function backgroundTerminalTerminateNotice(
  terminated: boolean | null | undefined,
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? terminated
          ? "后台进程已终止"
          : "后台进程已经结束"
        : terminated
          ? "Background process terminated"
          : "Background process was already finished",
    tone: "success",
  };
}

export function backgroundTerminalTerminateFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "终止后台进程失败"
      : "Unable to terminate background process";
}

export function backgroundTerminalTerminateFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: backgroundTerminalTerminateFailureMessage(error, locale),
  };
}

export function backgroundTerminalTerminateFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(
    panel,
    backgroundTerminalTerminateFailurePatch(error, locale),
  );
}

export function terminalInputSentBody(
  currentBody: string | null | undefined,
  locale: Locale,
): string {
  return `${currentBody ?? ""}\n${
    locale === "zh" ? "[已发送输入]" : "[input sent]"
  }`.trim();
}

export function terminalInputSentPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  if (!panel?.commandInput) {
    return panel;
  }
  return {
    ...panel,
    fields:
      updatePanelFieldValue(panel, "terminal-stdin", "")?.fields ??
      panel.fields,
    body: terminalInputSentBody(panel.body, locale),
  };
}

export function terminalInputFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "发送终端输入失败"
      : "Unable to send terminal input";
}

export function terminalInputFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: terminalInputFailureMessage(error, locale),
  };
}

export function terminalInputFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, terminalInputFailurePatch(error, locale));
}

export function terminalMissingThreadMessage(locale: Locale): string {
  return locale === "zh"
    ? "请先选择一个真实会话"
    : "Select a real session first";
}

export function terminalMissingThreadPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: terminalMissingThreadMessage(locale),
  };
}

export function terminalMissingThreadPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, terminalMissingThreadPatch(locale));
}

export function terminalSentToThreadDemoBody(locale: Locale): string {
  return locale === "zh"
    ? "命令已发送到会话（演示）。连接 app-server 后会调用 thread/shellCommand。"
    : "Command sent to the session (demo). With app-server connected this calls thread/shellCommand.";
}

export function terminalSentToThreadDemoPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: terminalSentToThreadDemoBody(locale),
    error: undefined,
  };
}

export function terminalSentToThreadDemoPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, terminalSentToThreadDemoPatch(locale));
}

export function terminalSendConfirmMessage(
  command: string,
  locale: Locale,
): string {
  return locale === "zh"
    ? `将命令发送到当前会话执行：${command}`
    : `Send this command to the current session: ${command}`;
}

export function terminalSentToThreadBody(
  command: string,
  locale: Locale,
): string {
  return locale === "zh"
    ? `已发送到会话：${command}`
    : `Sent to session: ${command}`;
}

export function terminalSentToThreadPatch(
  command: string,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: terminalSentToThreadBody(command, locale),
    error: undefined,
  };
}

export function terminalSentToThreadPanel(
  panel: CapabilityPanel | null,
  command: string,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, terminalSentToThreadPatch(command, locale));
}

export function terminalSentToThreadNotice(locale: Locale): NoticeState {
  return {
    text:
      locale === "zh"
        ? "命令已发送到当前会话"
        : "Command sent to the current session",
    tone: "success",
  };
}

export function terminalSendToThreadFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "发送命令到会话失败"
      : "Unable to send command to session";
}

export function terminalSendToThreadFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: terminalSendToThreadFailureMessage(error, locale),
  };
}

export function terminalSendToThreadFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, terminalSendToThreadFailurePatch(error, locale));
}

export function terminalStopFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "停止命令失败"
      : "Unable to stop command";
}

export function terminalStopFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: terminalStopFailureMessage(error, locale),
  };
}

export function terminalStopFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, terminalStopFailurePatch(error, locale));
}

export function terminalStoppingBody(
  currentBody: string | null | undefined,
  locale: Locale,
): string {
  return `${currentBody ?? ""}\n${
    locale === "zh" ? "正在停止..." : "Stopping..."
  }`.trim();
}

export function terminalStoppingPatch(
  currentBody: string | null | undefined,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    actions: undefined,
    body: terminalStoppingBody(currentBody, locale),
  };
}

export function terminalStoppingPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchPanelState(panel, terminalStoppingPatch(panel?.body, locale));
}
