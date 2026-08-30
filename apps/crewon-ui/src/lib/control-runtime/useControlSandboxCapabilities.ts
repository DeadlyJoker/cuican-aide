import type { ControlApiClient } from "@crewon/control-client";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../i18n";

const SANDBOX_ROOT = "/workspace";

export type SandboxCapabilityClient = Pick<
  ControlApiClient,
  | "listSandboxDirectory"
  | "readSandboxDiff"
  | "readSandboxFile"
  | "runSandboxCommand"
>;

type SetCapabilityPanel = (
  panel:
    | CapabilityPanel
    | null
    | ((current: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

export function useControlSandboxCapabilities(params: {
  appendTerminalOutputDelta: (processId: string, chunk: string) => void;
  appendTerminalOutputLine: (notice: string) => void;
  busyToolId: ToolId | null;
  client: SandboxCapabilityClient | null;
  locale: Locale;
  selectedThreadId: string | null;
  setBusyToolId: (toolId: ToolId | null) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setTerminalProcessId: (processId: string | null) => void;
  terminalCommand: string;
  terminalProcessId: () => string | null;
}) {
  const [terminalCwd, setTerminalCwd] = useState(SANDBOX_ROOT);
  const terminalCwdRef = useRef(terminalCwd);
  const terminalInputRef = useRef("");
  const commandQueueRef = useRef(Promise.resolve());
  terminalCwdRef.current = terminalCwd;

  useEffect(() => {
    terminalCwdRef.current = SANDBOX_ROOT;
    setTerminalCwd(SANDBOX_ROOT);
    terminalInputRef.current = "";
    if (params.terminalProcessId()?.startsWith("control-sandbox:")) {
      params.setTerminalProcessId(null);
    }
  }, [params.client, params.selectedThreadId]);

  const requireRuntime = useCallback(() => {
    if (params.client === null) {
      throw new Error(
        params.locale === "zh"
          ? "线上工作区尚未连接。"
          : "The online workspace is not connected.",
      );
    }
    return { client: params.client, threadId: params.selectedThreadId };
  }, [params.client, params.locale, params.selectedThreadId]);

  const openWorkspacePath = useCallback(
    async (item: Pick<CapabilityPanelItem, "kind" | "label" | "path">) => {
      if (!item.path) return;
      const { client, threadId } = requireRuntime();
      params.setBusyToolId("files");
      try {
        if (item.kind === "directory") {
          const view = await client.listSandboxDirectory(threadId, item.path);
          params.setCapabilityPanel({
            title: params.locale === "zh" ? "文件" : "Files",
            subtitle: view.path,
            body:
              params.locale === "zh"
                ? `工作区沙箱 · ${view.entries.length} 项${view.truncated ? "（已截断）" : ""}`
                : `Workspace sandbox · ${view.entries.length} items${view.truncated ? " (truncated)" : ""}`,
            items: view.entries.map((entry) => ({
              kind: entry.kind === "directory" ? "directory" : "file",
              label: `${entry.kind === "directory" ? ">" : " "} ${entry.name}`,
              path: entry.path,
            })),
          });
        } else {
          const view = await client.readSandboxFile(threadId, item.path);
          const name = view.path.split("/").at(-1) || item.label.trim();
          params.setCapabilityPanel({
            title: name,
            subtitle: view.path,
            body: [
              `${params.locale === "zh" ? "类型" : "Type"}: file · ${view.byteLength} bytes${view.truncated ? (params.locale === "zh" ? " · 预览已截断" : " · preview truncated") : ""}`,
              view.content ||
                (params.locale === "zh" ? "文件为空" : "Empty file"),
            ].join("\n\n"),
          });
        }
      } catch (error) {
        params.setCapabilityPanel({
          title: params.locale === "zh" ? "文件" : "Files",
          subtitle: item.path,
          error: errorText(
            error,
            params.locale,
            "读取沙箱文件失败",
            "Unable to read sandbox files",
          ),
        });
      } finally {
        params.setBusyToolId(null);
      }
    },
    [
      params.locale,
      params.setBusyToolId,
      params.setCapabilityPanel,
      requireRuntime,
    ],
  );

  const readWorkspaceFiles = useCallback(
    () =>
      openWorkspacePath({
        kind: "directory",
        label: SANDBOX_ROOT,
        path: SANDBOX_ROOT,
      }),
    [openWorkspacePath],
  );

  const readWorkspaceDiff = useCallback(async () => {
    const { client, threadId } = requireRuntime();
    params.setBusyToolId("review");
    params.setCapabilityPanel({
      title: params.locale === "zh" ? "当前改动" : "Current changes",
      subtitle: SANDBOX_ROOT,
      body:
        params.locale === "zh"
          ? "正在读取沙箱 git diff…"
          : "Reading sandbox git diff…",
    });
    try {
      const view = await client.readSandboxDiff(threadId);
      const files = view.diff.match(/^diff --git /gmu)?.length ?? 0;
      const added = view.diff.match(/^\+(?!\+\+)/gmu)?.length ?? 0;
      const removed = view.diff.match(/^-(?!--)/gmu)?.length ?? 0;
      params.setCapabilityPanel({
        title: params.locale === "zh" ? "当前改动" : "Current changes",
        subtitle:
          params.locale === "zh"
            ? `${files} 个文件 · +${added} / -${removed} · 工作区沙箱`
            : `${files} files · +${added} / -${removed} · workspace sandbox`,
        body:
          view.diff ||
          (params.locale === "zh"
            ? "当前沙箱没有未提交改动。"
            : "The sandbox has no uncommitted changes."),
      });
    } catch (error) {
      params.setCapabilityPanel({
        title: params.locale === "zh" ? "当前改动" : "Current changes",
        subtitle: SANDBOX_ROOT,
        error: errorText(
          error,
          params.locale,
          "读取沙箱改动失败",
          "Unable to read sandbox changes",
        ),
      });
    } finally {
      params.setBusyToolId(null);
    }
  }, [
    params.locale,
    params.setBusyToolId,
    params.setCapabilityPanel,
    requireRuntime,
  ]);

  const executeTerminalCommand = useCallback(
    async (processId: string, command: string) => {
      const { client, threadId } = requireRuntime();
      const response = await client.runSandboxCommand(threadId, {
        command,
        cwd: terminalCwdRef.current,
      });
      terminalCwdRef.current = response.cwd;
      setTerminalCwd(response.cwd);
      if (params.terminalProcessId() !== processId) return;
      const output = [response.stdout, response.stderr]
        .filter(Boolean)
        .join(response.stdout && response.stderr ? "\n" : "");
      if (output)
        params.appendTerminalOutputDelta(processId, terminalText(output));
      if (response.exitCode !== 0) {
        params.appendTerminalOutputDelta(
          processId,
          `\r\n[exit ${response.exitCode}]`,
        );
      }
      params.appendTerminalOutputDelta(processId, "\r\n$ ");
    },
    [
      params.appendTerminalOutputDelta,
      params.terminalProcessId,
      requireRuntime,
    ],
  );

  const startTerminal = useCallback(async () => {
    const { threadId } = requireRuntime();
    if (params.terminalProcessId()) return;
    const processId = `control-sandbox:${threadId ?? "draft"}:${Date.now()}`;
    params.setTerminalProcessId(processId);
    params.appendTerminalOutputDelta(
      processId,
      params.locale === "zh"
        ? "已连接工作区沙箱 /workspace\r\n$ "
        : "Connected to workspace sandbox /workspace\r\n$ ",
    );
  }, [
    params.appendTerminalOutputDelta,
    params.locale,
    params.setTerminalProcessId,
    params.terminalProcessId,
    requireRuntime,
  ]);

  const writeTerminal = useCallback(
    async (input: string) => {
      const processId = params.terminalProcessId();
      if (!processId || !input) return;
      for (const character of input) {
        if (character === "\u0003") {
          terminalInputRef.current = "";
          params.appendTerminalOutputDelta(processId, "^C\r\n$ ");
        } else if (character === "\u007f") {
          if (terminalInputRef.current) {
            terminalInputRef.current = terminalInputRef.current.slice(0, -1);
            params.appendTerminalOutputDelta(processId, "\b \b");
          }
        } else if (character === "\r" || character === "\n") {
          const command = terminalInputRef.current.trim();
          terminalInputRef.current = "";
          params.appendTerminalOutputDelta(processId, "\r\n");
          if (!command) {
            params.appendTerminalOutputDelta(processId, "$ ");
          } else {
            commandQueueRef.current = commandQueueRef.current
              .then(() => executeTerminalCommand(processId, command))
              .catch((error) => {
                if (params.terminalProcessId() !== processId) return;
                params.appendTerminalOutputDelta(
                  processId,
                  `${errorText(error, params.locale, "命令执行失败", "Command failed")}\r\n$ `,
                );
              });
          }
        } else if (character >= " ") {
          terminalInputRef.current += character;
          params.appendTerminalOutputDelta(processId, character);
        }
      }
    },
    [
      executeTerminalCommand,
      params.appendTerminalOutputDelta,
      params.locale,
      params.terminalProcessId,
    ],
  );

  const stopTerminal = useCallback(async () => {
    if (!params.terminalProcessId()?.startsWith("control-sandbox:")) return;
    params.setTerminalProcessId(null);
    params.appendTerminalOutputLine(
      params.locale === "zh"
        ? "[沙箱终端已断开]"
        : "[Sandbox terminal disconnected]",
    );
  }, [
    params.appendTerminalOutputLine,
    params.locale,
    params.setTerminalProcessId,
    params.terminalProcessId,
  ]);

  const runTerminalStatus = useCallback(async () => {
    const command = params.terminalCommand.trim();
    if (!command || params.busyToolId) return;
    const { client, threadId } = requireRuntime();
    params.setBusyToolId("terminal");
    try {
      const response = await client.runSandboxCommand(threadId, {
        command,
        cwd: terminalCwdRef.current,
      });
      terminalCwdRef.current = response.cwd;
      setTerminalCwd(response.cwd);
      params.setCapabilityPanel({
        title: params.locale === "zh" ? "终端" : "Terminal",
        subtitle: `${command} · exit ${response.exitCode}`,
        body:
          [response.stdout, response.stderr].filter(Boolean).join("\n") ||
          "(no output)",
      });
    } finally {
      params.setBusyToolId(null);
    }
  }, [
    params.busyToolId,
    params.locale,
    params.setBusyToolId,
    params.setCapabilityPanel,
    params.terminalCommand,
    requireRuntime,
  ]);

  return {
    openWorkspacePath,
    readWorkspaceDiff,
    readWorkspaceFiles,
    resizeTerminal: async () => undefined,
    runTerminalStatus,
    startTerminal,
    stopTerminal,
    terminalCwd,
    writeTerminal,
  };
}

function terminalText(value: string): string {
  return value.replace(/\r?\n/gu, "\r\n");
}

function errorText(
  error: unknown,
  locale: Locale,
  zhFallback: string,
  enFallback: string,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? zhFallback
      : enFallback;
}
