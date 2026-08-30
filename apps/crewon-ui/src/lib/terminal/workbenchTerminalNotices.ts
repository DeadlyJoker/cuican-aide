import type { Locale } from "../i18n";

/*
 * Status lines written into the workbench terminal's own output stream. They
 * used to be capability-panel fields, which meant opening review or files
 * erased them along with the live session's output.
 */

/** Dim so status never reads as program output. */
function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}

function red(text: string): string {
  return `\x1b[31m${text}\x1b[0m`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function workbenchTerminalDemoNotice(locale: Locale): string {
  return dim(
    locale === "zh"
      ? "[演示模式：终端不会真实执行。连接 app-server 后可运行命令。]"
      : "[Demo mode: the terminal does not execute. Connect app-server to run commands.]",
  );
}

export function workbenchTerminalWorkspaceRequiredNotice(
  locale: Locale,
): string {
  return red(
    locale === "zh"
      ? "[无法启动终端：未连接 app-server 或没有可用工作空间。]"
      : "[Cannot start the terminal: app-server is not connected or no workspace is available.]",
  );
}

export function workbenchTerminalExitNotice(
  exitCode: number | null | undefined,
  locale: Locale,
): string {
  const code = exitCode ?? 0;
  return dim(
    locale === "zh" ? `[会话已结束 · exit ${code}]` : `[Session ended · exit ${code}]`,
  );
}

export function workbenchTerminalErrorNotice(
  error: unknown,
  locale: Locale,
): string {
  return red(
    `[${errorText(error, locale === "zh" ? "终端会话失败" : "Terminal session failed")}]`,
  );
}

export function workbenchTerminalWriteErrorNotice(
  error: unknown,
  locale: Locale,
): string {
  return red(
    `[${errorText(error, locale === "zh" ? "写入终端失败" : "Unable to write to terminal")}]`,
  );
}

export function workbenchTerminalStopErrorNotice(
  error: unknown,
  locale: Locale,
): string {
  return red(
    `[${errorText(error, locale === "zh" ? "停止终端失败" : "Unable to stop terminal")}]`,
  );
}
