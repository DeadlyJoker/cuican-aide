import { describe, expect, it } from "vitest";

import { sandboxDiffCapabilityPanel } from "./useControlSandboxCapabilities";

const exact = {
  additions: 21_744,
  branch: "main",
  changedFiles: 437,
  cwd: "/workspace",
  deletions: 1_211_153,
  diff: "diff --git a/a.ts b/a.ts\n+partial",
  diffTruncated: true,
  head: "0".repeat(40),
  isGitRepository: true as const,
  statsComplete: true,
};

describe("sandboxDiffCapabilityPanel", () => {
  it("keeps complete totals when only the visible diff is truncated", () => {
    expect(sandboxDiffCapabilityPanel(exact, "zh")).toMatchObject({
      subtitle: "437 个文件 · +21,744 / -1,211,153 · 工作区沙箱",
      body: expect.stringContaining("以下仅为截断预览"),
    });
  });

  it("never derives totals from a legacy or partial diff", () => {
    const panel = sandboxDiffCapabilityPanel(
      {
        ...exact,
        additions: null,
        changedFiles: null,
        deletions: null,
        diffTruncated: false,
        isGitRepository: "unknown",
        statsComplete: false,
      },
      "zh",
    );

    expect(panel.subtitle).toBe("变更统计不可用 · 工作区沙箱");
    expect(panel.subtitle).not.toMatch(/[+-]\d/u);
  });

  it("only calls an authoritative empty result clean", () => {
    expect(
      sandboxDiffCapabilityPanel(
        {
          ...exact,
          additions: 0,
          changedFiles: 0,
          deletions: 0,
          diff: "",
          diffTruncated: false,
        },
        "zh",
      ).body,
    ).toBe("当前沙箱没有未提交改动。");
    expect(
      sandboxDiffCapabilityPanel(
        {
          ...exact,
          additions: null,
          changedFiles: null,
          deletions: null,
          diff: "",
          diffTruncated: true,
          statsComplete: false,
        },
        "zh",
      ).subtitle,
    ).toContain("预览已截断");
  });

  it("reports a non-Git workspace explicitly", () => {
    expect(
      sandboxDiffCapabilityPanel(
        {
          ...exact,
          additions: 0,
          branch: null,
          changedFiles: 0,
          deletions: 0,
          diff: "",
          diffTruncated: false,
          head: null,
          isGitRepository: false,
          statsComplete: false,
        },
        "en",
      ),
    ).toMatchObject({
      subtitle: "/workspace",
      body: "The current workspace is not a Git repository.",
    });
  });
});
