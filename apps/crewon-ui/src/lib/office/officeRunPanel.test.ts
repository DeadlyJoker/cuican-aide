import { describe, expect, it } from "vitest";

import type { OfficeRunResponse } from "../app-server/appServer";
import type {
  OfficeRunActivity,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import {
  officeRunActiveTurnByThread,
  officeRunCanceledPanel,
  officeRunCancelFallbackError,
  officeRunCancelFailureNotice,
  officeRunCancelingPanel,
  officeRunCancelRollbackPanel,
  officeRunCancelUnavailableNotice,
  officeRunCancelUnavailableNoticeState,
  officeRunCancelUnsupportedNotice,
  officeRunCancelUnsupportedNoticeState,
  officeRunResponsePanel,
  officeRunRetryActionLabel,
  officeRunRetryFallbackError,
  officeRunRetryFailureNotice,
  officeRunRetryLimitNotice,
  officeRunRetryLimitReached,
  officeRunRetryPendingActionLabel,
  officeRunRetryText,
  officeRunSyncedPanel,
  officeRunTurnRecord,
  officeWorkspaceFromRunResponse,
  officeWorkspaceWithCancelingRun,
  officeWorkspaceWithRunStatus,
} from "./officeRunPanel";

function run(overrides: Partial<OfficeRunActivity> = {}): OfficeRunActivity {
  return {
    id: "run-1",
    title: "Summarize office",
    status: "running",
    ...overrides,
  };
}

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Ship cleaner frontend",
    members: [],
    messages: [],
    tasks: [],
    backendStatus: "connected",
    activity: {
      trace: [],
      approvals: [],
      budget: [],
      budgetCapUsd: 8,
      artifacts: [],
      runs: [run(), run({ id: "run-2", status: "queued" })],
    },
    ...overrides,
  };
}

function runResponse(
  overrides: Partial<OfficeRunResponse> = {},
): OfficeRunResponse {
  return {
    filePath: "/tmp/offices/cleaner.json",
    runId: "run-1",
    threadId: "thread-1",
    config: {
      title: "Frontend office",
      subtitle: "Cleaner frontend architecture",
      workspace: workspace({
        backendStatus: "local",
        threadId: "old-thread",
      }),
    },
    turn: {
      id: "turn-1",
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    },
    ...overrides,
  };
}

describe("office run panel helpers", () => {
  it("selects retry text from run fields", () => {
    expect(
      officeRunRetryText(
        run({
          requestText: "  request  ",
          promptPreview: "prompt",
          title: "title",
        }),
      ),
    ).toBe("request");
    expect(
      officeRunRetryText(run({ requestText: "", promptPreview: " prompt " })),
    ).toBe("");
    expect(officeRunRetryText(run({ promptPreview: " prompt " }))).toBe(
      "prompt",
    );
    expect(officeRunRetryText(run({ promptPreview: "" }))).toBe("");
    expect(officeRunRetryText(run())).toBe("Summarize office");
  });

  it("builds review-aware retry text and labels", () => {
    const blockedRun = run({
      status: "completed",
      requestText: "Ship release",
      loop: {
        review: {
          status: "blocked",
          nextAction: "repairFailedCriteria",
        },
      },
      acceptanceCriteria: [
        {
          criterion: "All checks pass",
          status: "failed",
          evidence: "Integration test failed",
        },
      ],
      evidence: [
        {
          summary: "Integration test failed",
          status: "blocked",
          source: "just test",
        },
      ],
      verificationChecks: [
        {
          check: "Run integration suite",
          status: "failed",
          command: "just test -p crewon-app-server",
          evidence: "suite failed",
        },
      ],
      risks: [
        {
          summary: "Release could regress users",
          severity: "high",
        },
      ],
    });

    const retryText = officeRunRetryText(blockedRun, "en");
    expect(retryText).toContain("Continue the previous Office Loop");
    expect(retryText).toContain("Next action: repairFailedCriteria");
    expect(retryText).toContain("All checks pass");
    expect(retryText).toContain("Failed or pending verification checks");
    expect(retryText).toContain("Run integration suite");
    expect(retryText).toContain("Integration test failed");
    expect(retryText).toContain("Release could regress users");
    expect(officeRunRetryActionLabel(blockedRun, "en")).toBe("Repair");
    expect(
      officeRunRetryActionLabel(
        run({
          loop: { review: { status: "needsReview" } },
        }),
        "en",
      ),
    ).toBe("Continue loop");
    expect(
      officeRunRetryActionLabel(
        run({
          loop: { review: { status: "passed" } },
        }),
        "en",
      ),
    ).toBe("Retry");
  });

  it("builds verification-check retry text and labels", () => {
    const needsCheckRun = run({
      status: "completed",
      requestText: "Verify release readiness",
      loop: {
        review: {
          status: "needsReview",
          nextAction: "runVerificationChecks",
        },
      },
      verificationChecks: [
        {
          check: "Run smoke automation",
          status: "pending",
          automationId: "nightly-smoke",
        },
      ],
    });

    const retryText = officeRunRetryText(needsCheckRun, "en");
    expect(retryText).toContain(
      "Continue the previous Office Loop by running the pending verification checks.",
    );
    expect(retryText).toContain("Next action: runVerificationChecks");
    expect(retryText).toContain("Run smoke automation");
    expect(retryText).toContain(
      "do not mark checks passed without real tool evidence",
    );
    expect(officeRunRetryActionLabel(needsCheckRun, "en")).toBe("Run checks");
    expect(officeRunRetryActionLabel(needsCheckRun, "zh")).toBe("运行检查");
    expect(officeRunRetryPendingActionLabel(needsCheckRun, "en")).toBe(
      "Running checks",
    );
    expect(officeRunRetryPendingActionLabel(needsCheckRun, "zh")).toBe(
      "运行检查中",
    );
  });

  it("builds pending retry labels from review state", () => {
    expect(officeRunRetryPendingActionLabel(run(), "en")).toBe("Retrying");
    expect(
      officeRunRetryPendingActionLabel(
        run({
          loop: { review: { status: "blocked", nextAction: "repairFailedCriteria" } },
        }),
        "en",
      ),
    ).toBe("Repairing");
    expect(
      officeRunRetryPendingActionLabel(
        run({
          loop: { review: { status: "needsReview" } },
        }),
        "en",
      ),
    ).toBe("Continuing loop");
  });

  it("detects office loop retry limits", () => {
    const limitRun = run({
      status: "completed",
      loop: {
        iteration: 4,
        maxIterations: 4,
        review: {
          status: "needsReview",
        },
      },
    });

    expect(officeRunRetryLimitReached(limitRun)).toBe(true);
    expect(officeRunRetryActionLabel(limitRun, "en")).toBe("Limit reached");
    expect(officeRunRetryActionLabel(limitRun, "zh")).toBe("达到上限");
    expect(officeRunRetryLimitNotice("en")).toEqual({
      text: "Office Loop iteration limit reached. Adjust the goal or start a new team run.",
      tone: "warning",
    });
    expect(
      officeRunRetryLimitReached(
        run({
          status: "completed",
          loop: {
            iteration: 4,
            maxIterations: 4,
            review: {
              status: "passed",
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("builds cancel and retry notices", () => {
    expect(officeRunCancelUnavailableNotice("en")).toBe(
      "Only active backend office runs can be canceled",
    );
    expect(officeRunCancelUnsupportedNotice("zh")).toBe(
      "当前后端不支持 office/run/cancel",
    );
    expect(officeRunCancelFallbackError("en")).toBe(
      "Unable to cancel office run",
    );
    expect(officeRunRetryFallbackError("zh")).toBe("重试办公室任务失败");
    expect(officeRunCancelUnavailableNoticeState("en")).toEqual({
      text: "Only active backend office runs can be canceled",
      tone: "warning",
    });
    expect(officeRunCancelUnsupportedNoticeState("zh")).toEqual({
      text: "当前后端不支持 office/run/cancel",
      tone: "warning",
    });
    expect(officeRunCancelFailureNotice(null, "en")).toEqual({
      text: "Unable to cancel office run",
      tone: "warning",
    });
    expect(officeRunCancelFailureNotice(new Error("denied"), "zh")).toEqual({
      text: "denied",
      tone: "warning",
    });
    expect(officeRunRetryFailureNotice(null, "zh")).toEqual({
      text: "重试办公室任务失败",
      tone: "warning",
    });
  });

  it("builds run state from a backend response", () => {
    const response = runResponse();

    expect(officeRunTurnRecord("/workspace", response)).toEqual({
      cwd: "/workspace",
      runId: "run-1",
      threadId: "thread-1",
      turnThreadId: "thread-1",
      config: response.config,
    });
    expect(officeWorkspaceFromRunResponse(response)).toEqual({
      ...response.config.workspace,
      threadId: "thread-1",
      backendStatus: "connected",
    });
    expect(
      officeRunResponsePanel(
        {
          kind: "office",
          title: "Frontend Office",
          subtitle: "Refactor desk",
          items: [],
          workspace: workspace(),
        },
        response,
      ),
    ).toMatchObject({
      configPath: "/tmp/offices/cleaner.json",
      workspace: {
        threadId: "thread-1",
        backendStatus: "connected",
      },
    });
    expect(
      officeRunSyncedPanel(
        {
          kind: "office",
          title: "Frontend Office",
          subtitle: "Refactor desk",
          items: [],
          workspace: workspace({ threadId: "thread-1" }),
        },
        { config: response.config, threadId: "thread-1" },
      ),
    ).toMatchObject({
      workspace: {
        threadId: "thread-1",
        backendStatus: "connected",
      },
    });
    expect(
      officeRunSyncedPanel(
        {
          kind: "office",
          title: "Frontend Office",
          subtitle: "Refactor desk",
          items: [],
          workspace: workspace({ threadId: "other-thread" }),
        },
        { config: response.config, threadId: "thread-1" },
      ),
    ).toMatchObject({
      workspace: {
        threadId: "other-thread",
      },
    });
  });

  it("keeps office identity when a delegation response targets a member thread", () => {
    const response = runResponse({
      threadId: "member-thread-1",
      config: {
        title: "Frontend office",
        subtitle: "Cleaner frontend architecture",
        workspace: workspace({
          threadId: "office-thread-1",
          activity: {
            approvals: [],
            artifacts: [],
            budget: [],
            budgetCapUsd: 8,
            runs: [
              run({
                delegations: [
                  {
                    id: "delegation-1",
                    member: "Reviewer",
                    status: "running",
                    task: "Review",
                    threadId: "member-thread-1",
                    turnId: "turn-1",
                  },
                ],
              }),
            ],
            trace: [],
          },
        }),
      },
    });

    expect(officeRunTurnRecord("/workspace", response)).toEqual({
      cwd: "/workspace",
      runId: "run-1",
      threadId: "office-thread-1",
      turnThreadId: "member-thread-1",
      config: response.config,
    });
    expect(officeWorkspaceFromRunResponse(response)).toMatchObject({
      threadId: "office-thread-1",
      backendStatus: "connected",
    });
    expect(
      officeRunActiveTurnByThread({ other: "turn-other" }, response),
    ).toEqual({
      "other": "turn-other",
      "member-thread-1": "turn-1",
    });
  });

  it("patches the active turn only for in-progress run responses", () => {
    expect(
      officeRunActiveTurnByThread({ other: "turn-other" }, runResponse()),
    ).toEqual({
      "other": "turn-other",
      "thread-1": "turn-1",
    });

    const current = { other: "turn-other" };
    const next = officeRunActiveTurnByThread(
      current,
      runResponse({
        turn: {
          ...runResponse().turn,
          status: "completed",
        },
      }),
    );

    expect(next).toBe(current);
  });

  it("marks a run as canceling without replacing existing request time", () => {
    expect(
      officeWorkspaceWithCancelingRun({
        workspace: workspace(),
        runId: "run-1",
        cancelRequestedAt: "now",
      }).activity?.runs,
    ).toEqual([
      {
        id: "run-1",
        title: "Summarize office",
        status: "canceling",
        cancelRequestedAt: "now",
      },
      {
        id: "run-2",
        title: "Summarize office",
        status: "queued",
      },
    ]);

    expect(
      officeWorkspaceWithCancelingRun({
        workspace: workspace({
          activity: {
            trace: [],
            approvals: [],
            budget: [],
            budgetCapUsd: 8,
            artifacts: [],
            runs: [run({ cancelRequestedAt: "already" })],
          },
        }),
        runId: "run-1",
        cancelRequestedAt: "now",
      }).activity?.runs?.[0],
    ).toMatchObject({
      status: "canceling",
      cancelRequestedAt: "already",
    });
  });

  it("builds panel updates for the cancel lifecycle", () => {
    const panel = {
      kind: "office" as const,
      title: "Frontend office",
      subtitle: "Cleaner frontend architecture",
      items: [],
      workspace: workspace(),
    };

    expect(
      officeRunCancelingPanel(panel, {
        runId: "run-1",
        cancelRequestedAt: "now",
      })?.workspace?.activity?.runs?.[0],
    ).toMatchObject({
      id: "run-1",
      status: "canceling",
      cancelRequestedAt: "now",
    });
    expect(
      officeRunCanceledPanel(panel, {
        config: runResponse().config,
        threadId: "thread-1",
      }),
    ).toMatchObject({
      workspace: {
        ...runResponse().config.workspace,
        threadId: "thread-1",
        backendStatus: "connected",
      },
    });
    expect(
      officeRunCancelRollbackPanel(
        {
          ...panel,
          workspace: officeWorkspaceWithCancelingRun({
            workspace: panel.workspace,
            runId: "run-1",
            cancelRequestedAt: "now",
          }),
        },
        {
          runId: "run-1",
          previousStatus: "running",
        },
      )?.workspace?.activity?.runs?.[0],
    ).toMatchObject({
      id: "run-1",
      status: "running",
    });
    expect(
      officeRunCancelingPanel(null, {
        runId: "run-1",
        cancelRequestedAt: "now",
      }),
    ).toBeNull();

    const agentsPanel = { ...panel, kind: "agents" as const };
    expect(
      officeRunCanceledPanel(agentsPanel, {
        config: runResponse().config,
        threadId: "thread-1",
      }),
    ).toBe(agentsPanel);
  });

  it("restores a run status", () => {
    expect(
      officeWorkspaceWithRunStatus({
        workspace: workspace({
          activity: {
            trace: [],
            approvals: [],
            budget: [],
            budgetCapUsd: 8,
            artifacts: [],
            runs: [run({ status: "canceling" })],
          },
        }),
        runId: "run-1",
        status: "running",
      }).activity?.runs?.[0],
    ).toMatchObject({
      id: "run-1",
      status: "running",
    });
  });
});
