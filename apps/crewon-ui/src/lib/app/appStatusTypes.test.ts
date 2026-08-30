import { describe, expect, it } from "vitest";

import {
  remoteDiffSummaryFromSettledResult,
  summarizeRemoteDiff,
} from "./appStatusTypes";

describe("app status helpers", () => {
  it("summarizes git diff stats while ignoring diff headers", () => {
    expect(
      summarizeRemoteDiff(
        [
          "diff --git a/src/a.ts b/src/a.ts",
          "index 111..222 100644",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,2 +1,3 @@",
          "-old line",
          "+new line",
          "+another line",
          " context",
          "diff --git a/src/b.ts b/src/b.ts",
          "--- a/src/b.ts",
          "+++ b/src/b.ts",
          "@@ -1 +1 @@",
          "-removed",
        ].join("\n"),
        "abc123",
      ),
    ).toEqual({
      status: "ready",
      added: 2,
      removed: 2,
      files: 2,
      sha: "abc123",
    });
  });

  it("summarizes fulfilled remote diff results", () => {
    expect(
      remoteDiffSummaryFromSettledResult(
        {
          status: "fulfilled",
          value: {
            diff: [
              "diff --git a/src/a.ts b/src/a.ts",
              "--- a/src/a.ts",
              "+++ b/src/a.ts",
              "@@ -1 +1,2 @@",
              "-old line",
              "+new line",
              "+another line",
            ].join("\n"),
            sha: "def456",
          },
        },
        "Unable to read remote diff",
      ),
    ).toEqual({
      status: "ready",
      added: 2,
      removed: 1,
      files: 1,
      sha: "def456",
    });
  });

  it("returns null for fulfilled empty remote diff results", () => {
    expect(
      remoteDiffSummaryFromSettledResult(
        { status: "fulfilled", value: undefined },
        "Unable to read remote diff",
      ),
    ).toBeNull();
  });

  it("summarizes rejected remote diff results", () => {
    expect(
      remoteDiffSummaryFromSettledResult(
        { status: "rejected", reason: new Error("not a git repository") },
        "Unable to read remote diff",
      ),
    ).toEqual({
      status: "error",
      added: 0,
      removed: 0,
      files: 0,
      error: "not a git repository",
    });

    expect(
      remoteDiffSummaryFromSettledResult(
        { status: "rejected", reason: "failed" },
        "Unable to read remote diff",
      ),
    ).toEqual({
      status: "error",
      added: 0,
      removed: 0,
      files: 0,
      error: "Unable to read remote diff",
    });
  });
});
