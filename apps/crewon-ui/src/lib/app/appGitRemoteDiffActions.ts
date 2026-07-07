import type { GitDiffToRemoteResponse } from "@crewon-protocol/GitDiffToRemoteResponse";

import {
  summarizeRemoteDiff,
  type GitRemoteDiffSummary,
} from "./appStatusTypes";

type GitRemoteDiffClient = {
  getGitDiffToRemote(cwd: string): Promise<GitDiffToRemoteResponse>;
};

export function runGitRemoteDiffEffectAction(params: {
  client: GitRemoteDiffClient | null | undefined;
  cwd: string;
  isConnected: boolean;
  isDemo: boolean;
  setGitRemoteDiff: (diff: GitRemoteDiffSummary | null) => void;
}): (() => void) | undefined {
  if (!params.isConnected || !params.cwd) {
    if (!params.isDemo) {
      params.setGitRemoteDiff(null);
    }
    return undefined;
  }

  let cancelled = false;
  params.setGitRemoteDiff({
    status: "loading",
    added: 0,
    removed: 0,
    files: 0,
  });

  void params.client
    ?.getGitDiffToRemote(params.cwd)
    .then((response) => {
      if (!cancelled) {
        params.setGitRemoteDiff(summarizeRemoteDiff(response.diff, response.sha));
      }
    })
    .catch((error) => {
      if (!cancelled) {
        params.setGitRemoteDiff({
          status: "error",
          added: 0,
          removed: 0,
          files: 0,
          error:
            error instanceof Error ? error.message : "Unable to read git diff",
        });
      }
    });

  return () => {
    cancelled = true;
  };
}
