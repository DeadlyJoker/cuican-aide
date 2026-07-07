import { describe, expect, it } from "vitest";

import type { GitRemoteDiffSummary } from "./appStatusTypes";
import { runGitRemoteDiffEffectAction } from "./appGitRemoteDiffActions";

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("app git remote diff actions", () => {
  it("clears remote diff when disconnected outside demo mode", () => {
    let remoteDiff: GitRemoteDiffSummary | null = {
      status: "ready",
      added: 1,
      removed: 0,
      files: 1,
    };

    const cleanup = runGitRemoteDiffEffectAction({
      client: null,
      cwd: "/repo",
      isConnected: false,
      isDemo: false,
      setGitRemoteDiff: (nextRemoteDiff) => {
        remoteDiff = nextRemoteDiff;
      },
    });

    expect(cleanup).toBeUndefined();
    expect(remoteDiff).toBeNull();
  });

  it("preserves remote diff while disconnected in demo mode", () => {
    const existingRemoteDiff: GitRemoteDiffSummary = {
      status: "ready",
      added: 1,
      removed: 0,
      files: 1,
    };
    let remoteDiff: GitRemoteDiffSummary | null = existingRemoteDiff;

    const cleanup = runGitRemoteDiffEffectAction({
      client: null,
      cwd: "/repo",
      isConnected: false,
      isDemo: true,
      setGitRemoteDiff: (nextRemoteDiff) => {
        remoteDiff = nextRemoteDiff;
      },
    });

    expect(cleanup).toBeUndefined();
    expect(remoteDiff).toEqual(existingRemoteDiff);
  });

  it("loads and summarizes the remote diff", async () => {
    const remoteDiffs: Array<GitRemoteDiffSummary | null> = [];

    runGitRemoteDiffEffectAction({
      client: {
        async getGitDiffToRemote(cwd) {
          expect(cwd).toBe("/repo");
          return {
            diff: [
              "diff --git a/src/a.ts b/src/a.ts",
              "--- a/src/a.ts",
              "+++ b/src/a.ts",
              "@@ -1 +1,2 @@",
              "-old line",
              "+new line",
              "+another line",
            ].join("\n"),
            sha: "abc123",
          };
        },
      },
      cwd: "/repo",
      isConnected: true,
      isDemo: false,
      setGitRemoteDiff: (remoteDiff) => {
        remoteDiffs.push(remoteDiff);
      },
    });
    await settlePromises();

    expect(remoteDiffs).toEqual([
      { status: "loading", added: 0, removed: 0, files: 0 },
      { status: "ready", added: 2, removed: 1, files: 1, sha: "abc123" },
    ]);
  });

  it("surfaces remote diff failures", async () => {
    const remoteDiffs: Array<GitRemoteDiffSummary | null> = [];

    runGitRemoteDiffEffectAction({
      client: {
        async getGitDiffToRemote() {
          throw new Error("not a git repository");
        },
      },
      cwd: "/repo",
      isConnected: true,
      isDemo: false,
      setGitRemoteDiff: (remoteDiff) => {
        remoteDiffs.push(remoteDiff);
      },
    });
    await settlePromises();

    expect(remoteDiffs).toEqual([
      { status: "loading", added: 0, removed: 0, files: 0 },
      {
        status: "error",
        added: 0,
        removed: 0,
        files: 0,
        error: "not a git repository",
      },
    ]);
  });

  it("ignores remote diff results after cleanup", async () => {
    let resolveDiff: (response: { diff: string; sha: string }) => void = () => {};
    const remoteDiffs: Array<GitRemoteDiffSummary | null> = [];

    const cleanup = runGitRemoteDiffEffectAction({
      client: {
        getGitDiffToRemote() {
          return new Promise((resolve) => {
            resolveDiff = resolve;
          });
        },
      },
      cwd: "/repo",
      isConnected: true,
      isDemo: false,
      setGitRemoteDiff: (remoteDiff) => {
        remoteDiffs.push(remoteDiff);
      },
    });

    cleanup?.();
    resolveDiff({ diff: "+new line", sha: "abc123" });
    await settlePromises();

    expect(remoteDiffs).toEqual([
      { status: "loading", added: 0, removed: 0, files: 0 },
    ]);
  });
});
