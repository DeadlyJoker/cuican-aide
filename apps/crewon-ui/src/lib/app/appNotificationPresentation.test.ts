import { describe, expect, it } from "vitest";

import {
  accountLoginNotice,
  accountRateLimitNotice,
  appWarningNotice,
  automationRunSyncFailureNotice,
  configWarningNotice,
  connectionLostNotice,
  desktopPreferenceSyncFailureNotice,
  fileChangedNotice,
  fileChangedPanelAppendText,
  mcpOauthNotice,
  mcpStartupNotice,
  officeRunSyncFailureNotice,
  terminalOutputChunk,
} from "./appNotificationPresentation";

describe("app notification presentation helpers", () => {
  it("builds account login notices", () => {
    expect(accountLoginNotice(true, null, "en")).toEqual({
      text: "Account login completed",
      tone: "success",
    });
    expect(accountLoginNotice(false, "expired", "zh")).toEqual({
      text: "expired",
      tone: "warning",
    });
  });

  it("builds rate limit update notices", () => {
    expect(
      accountRateLimitNotice(
        {
          limitId: "primary",
          limitName: "Primary API",
          primary: {
            usedPercent: 42,
            resetsAt: null,
            windowDurationMins: null,
          },
          secondary: null,
          credits: null,
          individualLimit: null,
          planType: null,
          rateLimitReachedType: null,
        },
        "en",
      ),
    ).toEqual({
      text: "Rate limit: Primary API",
      tone: "success",
    });
    expect(accountRateLimitNotice(null, "zh")).toEqual({
      text: "账号额度已更新",
      tone: "success",
    });
  });

  it("builds config warning and MCP notices", () => {
    expect(
      configWarningNotice("Bad config", "Missing value", "/repo/config.toml"),
    ).toEqual({
      text: "Bad config\n/repo/config.toml\nMissing value",
      tone: "warning",
    });
    expect(mcpOauthNotice("github", false, "denied", "en")).toEqual({
      text: "denied",
      tone: "warning",
    });
    expect(mcpStartupNotice("github", "failed", "port busy")).toEqual({
      text: "github: failed\nport busy",
      tone: "warning",
    });
  });

  it("builds desktop preference sync failure notices", () => {
    expect(desktopPreferenceSyncFailureNotice(null, "en")).toEqual({
      text: "Unable to sync desktop preference",
      tone: "warning",
    });
    expect(
      desktopPreferenceSyncFailureNotice(new Error("config denied"), "zh"),
    ).toEqual({
      text: "config denied",
      tone: "warning",
    });
  });

  it("builds runtime sync and generic warning notices", () => {
    expect(automationRunSyncFailureNotice(null, "zh")).toEqual({
      text: "自动化运行状态同步失败",
      tone: "warning",
    });
    expect(
      automationRunSyncFailureNotice(new Error("automation denied"), "en"),
    ).toEqual({
      text: "automation denied",
      tone: "warning",
    });
    expect(officeRunSyncFailureNotice(null, "en")).toEqual({
      text: "Unable to sync office run status",
      tone: "warning",
    });
    expect(appWarningNotice("server warning")).toEqual({
      text: "server warning",
      tone: "warning",
    });
    expect(connectionLostNotice("Connection lost")).toEqual({
      text: "Connection lost",
      tone: "warning",
    });
  });

  it("builds file change notices and panel append text", () => {
    expect(fileChangedNotice(["/repo/a.ts"], "/repo", "en")).toEqual({
      text: "File changed: /repo/a.ts",
      tone: "success",
    });
    expect(fileChangedPanelAppendText(["a", "b", "c", "d", "e"], "en")).toBe(
      "File changes detected:\na\nb\nc\nd",
    );
  });

  it("builds terminal output chunks", () => {
    expect(terminalOutputChunk("stderr", "failed", true)).toBe(
      "[stderr] failed\n[output cap reached]",
    );
    expect(terminalOutputChunk("stdout", "ok", false)).toBe("ok");
  });
});
