import type { GitDiffToRemoteResponse } from "@crewon-ui-model/GitDiffToRemoteResponse";
import type { Account } from "@crewon-ui-model/v2/Account";

export type AccountStatus = {
  account: Account | null;
  requiresOpenaiAuth: boolean;
};

export type GitRemoteDiffSummary = {
  status: "loading" | "ready" | "error";
  added: number;
  removed: number;
  files: number;
  sha?: string;
  error?: string;
};

export function summarizeRemoteDiff(
  diff: string,
  sha: string,
): GitRemoteDiffSummary {
  return {
    status: "ready",
    added: diff.match(/^\+(?!\+\+)/gm)?.length ?? 0,
    removed: diff.match(/^-(?!--)/gm)?.length ?? 0,
    files: diff.match(/^diff --git /gm)?.length ?? 0,
    sha,
  };
}

export function remoteDiffSummaryFromSettledResult(
  result: PromiseSettledResult<GitDiffToRemoteResponse | undefined>,
  fallbackError: string,
): GitRemoteDiffSummary | null {
  if (result.status === "fulfilled") {
    return result.value
      ? summarizeRemoteDiff(result.value.diff, result.value.sha)
      : null;
  }

  return {
    status: "error",
    added: 0,
    removed: 0,
    files: 0,
    error: result.reason instanceof Error ? result.reason.message : fallbackError,
  };
}
