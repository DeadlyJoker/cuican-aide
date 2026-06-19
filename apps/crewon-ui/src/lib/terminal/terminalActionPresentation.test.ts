import { describe, expect, it } from "vitest";

import {
  backgroundTerminalActionFailureMessage,
  backgroundTerminalActionFailurePanel,
  backgroundTerminalActionFailurePatch,
  backgroundTerminalTerminateConfirmMessage,
  backgroundTerminalTerminateFailureMessage,
  backgroundTerminalTerminateFailurePanel,
  backgroundTerminalTerminateFailurePatch,
  backgroundTerminalTerminateNotice,
  backgroundTerminalsDemoBody,
  backgroundTerminalsDemoPanel,
  backgroundTerminalsDemoPatch,
  terminalInputFailureMessage,
  terminalInputFailurePanel,
  terminalInputFailurePatch,
  terminalInputSentBody,
  terminalInputSentPanel,
  terminalMissingThreadMessage,
  terminalMissingThreadPanel,
  terminalMissingThreadPatch,
  terminalSendConfirmMessage,
  terminalSendToThreadFailureMessage,
  terminalSendToThreadFailurePanel,
  terminalSendToThreadFailurePatch,
  terminalSentToThreadBody,
  terminalSentToThreadDemoBody,
  terminalSentToThreadDemoPanel,
  terminalSentToThreadDemoPatch,
  terminalSentToThreadNotice,
  terminalSentToThreadPanel,
  terminalSentToThreadPatch,
  terminalStopFailureMessage,
  terminalStopFailurePanel,
  terminalStopFailurePatch,
  terminalStoppingBody,
  terminalStoppingPanel,
  terminalStoppingPatch,
} from "./terminalActionPresentation";

describe("terminal action presentation helpers", () => {
  it("builds background terminal action feedback", () => {
    expect(backgroundTerminalsDemoBody("en")).toBe(
      "Demo mode has no background terminals. Connect app-server to read real session tasks.",
    );
    expect(backgroundTerminalsDemoPatch("zh")).toEqual({
      body: "演示模式下没有后台终端。连接 app-server 后会读取真实会话后台任务。",
      error: undefined,
    });
    expect(backgroundTerminalActionFailureMessage(null, "zh")).toBe(
      "后台终端操作失败",
    );
    expect(
      backgroundTerminalActionFailureMessage(new Error("denied"), "en"),
    ).toBe("denied");
    expect(backgroundTerminalActionFailurePatch(null, "en")).toEqual({
      error: "Background terminal action failed",
    });
    expect(
      backgroundTerminalsDemoPanel(
        { title: "Terminals", body: "Ready", error: "old" },
        "zh",
      ),
    ).toEqual({
      title: "Terminals",
      body: "演示模式下没有后台终端。连接 app-server 后会读取真实会话后台任务。",
      error: undefined,
    });
    expect(
      backgroundTerminalActionFailurePanel(
        { title: "Terminals", body: "Ready", error: "old" },
        null,
        "en",
      ),
    ).toEqual({
      title: "Terminals",
      body: "Ready",
      error: "Background terminal action failed",
    });
    expect(backgroundTerminalsDemoPanel(null, "en")).toBeNull();
  });

  it("builds background terminal termination feedback", () => {
    expect(backgroundTerminalTerminateConfirmMessage("proc-1", "en")).toBe(
      "Terminate background process: proc-1",
    );
    expect(backgroundTerminalTerminateNotice(true, "zh")).toEqual({
      text: "后台进程已终止",
      tone: "success",
    });
    expect(backgroundTerminalTerminateNotice(false, "en")).toEqual({
      text: "Background process was already finished",
      tone: "success",
    });
    expect(backgroundTerminalTerminateFailureMessage(null, "zh")).toBe(
      "终止后台进程失败",
    );
    expect(backgroundTerminalTerminateFailurePatch(null, "en")).toEqual({
      error: "Unable to terminate background process",
    });
    expect(
      backgroundTerminalTerminateFailurePanel(
        { title: "Terminal", body: "Ready", error: "old" },
        null,
        "zh",
      ),
    ).toEqual({
      title: "Terminal",
      body: "Ready",
      error: "终止后台进程失败",
    });
  });

  it("builds terminal input feedback", () => {
    expect(terminalInputSentBody("previous", "en")).toBe(
      "previous\n[input sent]",
    );
    expect(
      terminalInputSentPanel(
        {
          title: "Terminal",
          commandInput: true,
          body: "previous",
          fields: [{ id: "terminal-stdin", label: "Input", value: "hello" }],
        },
        "zh",
      ),
    ).toEqual({
      title: "Terminal",
      commandInput: true,
      body: "previous\n[已发送输入]",
      fields: [{ id: "terminal-stdin", label: "Input", value: "" }],
    });
    expect(
      terminalInputSentPanel({ title: "Terminal", body: "previous" }, "en"),
    ).toEqual({ title: "Terminal", body: "previous" });
    expect(terminalInputFailureMessage(null, "zh")).toBe(
      "发送终端输入失败",
    );
    expect(terminalInputFailurePatch(null, "en")).toEqual({
      error: "Unable to send terminal input",
    });
    expect(
      terminalInputFailurePanel(
        { title: "Terminal", body: "Ready", error: "old" },
        null,
        "zh",
      ),
    ).toEqual({
      title: "Terminal",
      body: "Ready",
      error: "发送终端输入失败",
    });
  });

  it("builds terminal send-to-thread feedback", () => {
    expect(terminalMissingThreadMessage("en")).toBe(
      "Select a real session first",
    );
    expect(terminalMissingThreadPatch("zh")).toEqual({
      error: "请先选择一个真实会话",
    });
    expect(terminalSendConfirmMessage("npm test", "zh")).toBe(
      "将命令发送到当前会话执行：npm test",
    );
    expect(terminalSentToThreadDemoBody("en")).toBe(
      "Command sent to the session (demo). With app-server connected this calls thread/shellCommand.",
    );
    expect(terminalSentToThreadDemoPatch("en")).toEqual({
      body: "Command sent to the session (demo). With app-server connected this calls thread/shellCommand.",
      error: undefined,
    });
    expect(terminalSentToThreadBody("npm test", "en")).toBe(
      "Sent to session: npm test",
    );
    expect(terminalSentToThreadPatch("npm test", "zh")).toEqual({
      body: "已发送到会话：npm test",
      error: undefined,
    });
    expect(terminalSentToThreadNotice("zh")).toEqual({
      text: "命令已发送到当前会话",
      tone: "success",
    });
    expect(terminalSendToThreadFailureMessage(null, "en")).toBe(
      "Unable to send command to session",
    );
    expect(terminalSendToThreadFailurePatch(null, "zh")).toEqual({
      error: "发送命令到会话失败",
    });
    expect(
      terminalMissingThreadPanel(
        { title: "Terminal", body: "Ready", error: "old" },
        "en",
      ),
    ).toEqual({
      title: "Terminal",
      body: "Ready",
      error: "Select a real session first",
    });
    expect(
      terminalSentToThreadDemoPanel(
        { title: "Terminal", body: "Ready", error: "old" },
        "en",
      ),
    ).toEqual({
      title: "Terminal",
      body: "Command sent to the session (demo). With app-server connected this calls thread/shellCommand.",
      error: undefined,
    });
    expect(
      terminalSentToThreadPanel(
        { title: "Terminal", body: "Ready", error: "old" },
        "npm test",
        "zh",
      ),
    ).toEqual({
      title: "Terminal",
      body: "已发送到会话：npm test",
      error: undefined,
    });
    expect(
      terminalSendToThreadFailurePanel(
        { title: "Terminal", body: "Ready", error: "old" },
        null,
        "en",
      ),
    ).toEqual({
      title: "Terminal",
      body: "Ready",
      error: "Unable to send command to session",
    });
  });

  it("builds terminal stop feedback", () => {
    expect(terminalStopFailureMessage(new Error("denied"), "zh")).toBe(
      "denied",
    );
    expect(terminalStopFailurePatch(null, "en")).toEqual({
      error: "Unable to stop command",
    });
    expect(terminalStoppingBody("previous", "en")).toBe(
      "previous\nStopping...",
    );
    expect(terminalStoppingPatch("previous", "zh")).toEqual({
      actions: undefined,
      body: "previous\n正在停止...",
    });
    expect(
      terminalStopFailurePanel(
        { title: "Terminal", body: "Ready", error: "old" },
        null,
        "en",
      ),
    ).toEqual({
      title: "Terminal",
      body: "Ready",
      error: "Unable to stop command",
    });
    expect(
      terminalStoppingPanel(
        {
          title: "Terminal",
          body: "previous",
          actions: [{ id: "stop-terminal", label: "Stop" }],
        },
        "zh",
      ),
    ).toEqual({
      title: "Terminal",
      body: "previous\n正在停止...",
      actions: undefined,
    });
    expect(terminalStoppingPanel(null, "en")).toBeNull();
  });
});
