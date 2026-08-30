import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ActivityBoard } from "./ActivityBoard";
import type { ActivityData } from "../../lib/domain/crewonDomain";

const activity: ActivityData = {
  trace: [
    {
      time: "10:12",
      actor: "Planner",
      glyph: "P",
      accent: "blue",
      action: "Planned",
      detail: "Split the delivery work into implementation and review.",
      tokens: 4200,
      status: "done",
    },
  ],
  approvals: [],
  budget: [
    {
      name: "Office team",
      glyph: "O",
      accent: "slate",
      usedTokens: 12000,
      budgetTokens: 50000,
      costUsd: 0.42,
    },
  ],
  budgetCapUsd: 8,
  artifacts: [
    {
      title: "delivery-plan.md",
      kind: "Doc",
      glyph: "D",
      accent: "green",
      meta: "Updated by Reviewer",
    },
  ],
  runs: [
    {
      id: "office-run-1",
      title: "Ship office backend",
      status: "running",
      threadId: "thread-office",
      turnId: "turn-1",
      goal: "Land a real Office Agent team execution loop.",
      promptPreview: "Implement index, reducer, cancel, retry, and UI.",
      loop: {
        mode: "officeLoopEngineering",
        iteration: 2,
        maxIterations: 4,
        phase: "summarize",
        status: "ready",
        cycle: ["frame", "plan", "delegate", "act", "observe", "verify"],
        memoryPolicy: "boundedRetrieval",
        review: {
          status: "passed",
          nextAction: "readyToSummarize",
          acceptance: {
            total: 1,
            passed: 1,
            failed: 0,
            pending: 0,
          },
          evidence: {
            total: 1,
            verified: 1,
            blocked: 0,
          },
          verification: {
            total: 1,
            passed: 1,
            failed: 0,
            pending: 0,
            runnablePending: 0,
            missingRunnablePending: 0,
          },
          risks: {
            total: 1,
            high: 0,
            openHigh: 0,
          },
          updatedAt: "10:14",
        },
      },
      plan: [
        { step: "Index every run", status: "completed" },
        { step: "Wire cancel and retry", status: "inProgress" },
      ],
      acceptanceCriteria: [
        {
          criterion: "Office run sync is observable",
          evidence: "turn sync assertions passed",
          status: "passed",
        },
      ],
      verificationChecks: [
        {
          check: "Run office sync regression",
          status: "passed",
          command: "just test -p crewon-app-server office_run",
          evidence: "regression passed",
        },
      ],
      evidence: [
        {
          summary: "Reducer wrote structured Office state",
          source: "turn-1",
          status: "verified",
        },
      ],
      risks: [
        {
          summary: "Retry path can drift",
          severity: "medium",
          mitigation: "Run retry regression",
        },
      ],
      delegations: [
        {
          member: "Reviewer",
          agentId: "agent-reviewer",
          task: "Review reducer behavior",
          status: "running",
          resultPreview: "Reducer behavior looks correct",
          threadId: "thread-reviewer",
          target: "thread-reviewer",
          tool: "followup_task",
          memoryRefs: [
            {
              id: "office-memory-reviewer",
              scope: "member",
              kind: "preference",
              member: "Reviewer",
              agentId: "agent-reviewer",
              status: "accepted",
              confidence: "high",
              importance: "high",
              evidenceRefs: [
                {
                  runId: "office-run-1",
                  threadId: "thread-reviewer",
                  turnId: "turn-reviewer",
                },
              ],
              content: "Reviewer prefers reducer evidence before approval.",
            },
          ],
        },
        {
          id: "delegation-queued",
          member: "Implementer",
          agentId: "agent-impl",
          task: "Implement dispatch action",
          status: "queued",
          target: "thread-impl",
          tool: "followup_task",
        },
      ],
      memoryRefs: [
        {
          id: "office-memory-1",
          scope: "office",
          kind: "decision",
          status: "accepted",
          confidence: "high",
          importance: "high",
          evidenceRefs: [
            {
              runId: "office-run-1",
              threadId: "thread-office",
              turnId: "turn-1",
            },
          ],
          content: "Keep Office run reducers in app-server.",
        },
      ],
      updatedAt: "10:14",
    },
    {
      id: "office-run-0",
      title: "Previous attempt",
      status: "failed",
      threadId: "thread-office",
      turnId: "turn-0",
      requestText: "Retryable request",
      error: "Tool approval timed out",
      updatedAt: "10:05",
    },
  ],
};

describe("ActivityBoard", () => {
  it("renders backend activity when optional demo sections are missing", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={{
          approvals: [],
          artifacts: [],
          runs: [
            {
              id: "office-run-backend",
              title: "Backend synced run",
              status: "completed",
              resultPreview: "Integration mock response",
            },
          ],
        }}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onDelegationDispatchNext={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
      />,
    );

    expect(markup).toContain("Backend synced run");
    expect(markup).toContain("Integration mock response");
    expect(markup).toContain("Approvals inbox");
    expect(markup).not.toContain("Execution trace");
    expect(markup).not.toContain("Usage &amp; budget");
  });

  it("keeps conversation-only manager replies out of the task run board", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={{
          approvals: [],
          artifacts: [],
          runs: [
            {
              id: "office-conversation-1",
              messageIntent: "conversation",
              status: "completed",
              title: "现在进度怎么样？",
            },
            {
              id: "office-task-1",
              messageIntent: "task",
              status: "running",
              title: "补齐发布测试",
            },
          ],
        }}
        locale="zh"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
      />,
    );

    expect(markup).not.toContain("现在进度怎么样？");
    expect(markup).toContain("补齐发布测试");
  });

  it("renders artifact provenance without opening member transcripts", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={{
          approvals: [],
          artifacts: [
            {
              title: "member-checklist.md",
              kind: "Doc",
              glyph: "D",
              accent: "green",
              meta: "Member checklist artifact",
              contentSha256:
                "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
              contentBytes: 2048,
              contentSource: "file",
              contentStatus: "fingerprinted",
              contentObservedAt: "2026-06-20T08:00:00.000Z",
              path: ".crewon/offices/artifacts/member-checklist.md",
              member: "Engineer",
              agentId: "agent-engineer",
              delegationId: "delegation-1",
              sourceTurnId: "turn-member",
            },
          ],
          runs: [],
        }}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onDelegationDispatchNext={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
      />,
    );

    expect(markup).toContain("member-checklist.md");
    expect(markup).toContain("file verified");
    expect(markup).toContain("sha fedcba987654");
    expect(markup).toContain("2048 bytes");
    expect(markup).toContain(".crewon/offices/artifacts/member-checklist.md");
    expect(markup).toContain("Engineer/agent-engineer");
    expect(markup).toContain("delegation-1");
    expect(markup).toContain("turn turn-member");
  });

  it("renders office run controls and structured reducer output", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={activity}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onDelegationDispatchNext={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
      />,
    );

    expect(markup).toContain("Ship office backend");
    expect(markup).toContain("Land a real Office Agent team execution loop.");
    expect(markup).toContain("Wire cancel and retry");
    expect(markup).toContain("Loop review");
    expect(markup).toContain("Ready to summarize");
    expect(markup).toContain("Iteration 2/4");
    expect(markup).toContain("Phase Summarize");
    expect(markup).toContain("Office run sync is observable");
    expect(markup).toContain("Checks 1/1");
    expect(markup).toContain("Run office sync regression");
    expect(markup).toContain("Reducer wrote structured Office state");
    expect(markup).toContain("Retry path can drift");
    expect(markup).toContain("agent-reviewer");
    expect(markup).toContain("Implement dispatch action");
    expect(markup).toContain("followup_task:thread-reviewer");
    expect(markup).toContain("Dispatch");
    expect(markup).toContain("Dispatch next");
    expect(markup).toContain("office · decision · accepted · high · importance high");
    expect(markup).toContain("turn turn-1");
    expect(markup).toContain("Keep Office run reducers in app-server.");
    expect(markup).toContain(
      "Memory member · preference · accepted · high · importance high",
    );
    expect(markup).toContain("Reviewer/agent-reviewer");
    expect(markup).toContain("turn turn-reviewer");
    expect(markup).toContain("Reviewer prefers reducer evidence before approval.");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Retry");
    expect(markup).toMatchInlineSnapshot(
      `"<div class="activity-board"><section class="activity-card activity-trace"><div class="activity-card-head"><h2>Execution trace</h2><span>Live</span></div><ol class="trace-timeline"><li class="trace-step" data-status="done"><span class="trace-glyph" data-accent="blue" aria-hidden="true">P</span><div class="trace-body"><div class="trace-top"><strong>Planner</strong><span class="trace-action">Planned</span><span class="trace-time">10:12</span></div><p class="trace-detail">Split the delivery work into implementation and review.</p><div class="trace-meta"><span class="trace-status" data-status="done">Done</span><span class="trace-tokens">4.2k tok</span></div></div></li></ol></section><div class="activity-rail"><section class="activity-card activity-runs"><div class="activity-card-head"><h2>Team runs</h2><span>1 active · 1 need attention</span></div><div class="office-run-list"><article class="office-run-row" data-status="running"><div class="office-run-top"><strong>Ship office backend</strong><span class="office-run-status" data-status="running">Running</span></div><p class="office-run-meta">turn turn-1 · 10:14</p><p class="office-run-goal"><span>Goal</span>Land a real Office Agent team execution loop.</p><p class="office-run-detail">Implement index, reducer, cancel, retry, and UI.</p><ol class="office-run-plan"><li data-status="completed"><span>Done</span><strong>Index every run</strong></li><li data-status="inProgress"><span>Running</span><strong>Wire cancel and retry</strong></li></ol><div class="office-run-loop-review" data-status="passed"><strong>Loop review</strong><span>Passed</span><span>Iteration 2/4</span><span>Phase Summarize</span><span>Criteria 1/1</span><span>Evidence 1/1</span><span>Checks 1/1</span><span>Ready to summarize</span></div><div class="office-run-signals"><span><strong>Criteria</strong> · passed · Office run sync is observable · turn sync assertions passed</span><span><strong>Check</strong> · passed · Run office sync regression · just test -p crewon-app-server office_run · regression passed</span><span><strong>Evidence</strong> · verified · Reducer wrote structured Office state · turn-1</span><span><strong>Risk</strong> · medium · Retry path can drift · Run retry regression</span></div><div class="office-run-delegations"><span class="office-run-delegation-row"><span class="office-run-delegation-text"><strong>Reviewer</strong> · agent-reviewer · Review reducer behavior · running · followup_task:thread-reviewer · Reducer behavior looks correct · Memory member · preference · accepted · high · importance high · Reviewer/agent-reviewer · turn turn-reviewer · Reviewer prefers reducer evidence before approval.</span></span><span class="office-run-delegation-row"><span class="office-run-delegation-text"><strong>Implementer</strong> · agent-impl · Implement dispatch action · queued · followup_task:thread-impl</span><button type="button">Dispatch</button></span></div><div class="office-run-memory-refs"><span><strong>Memory</strong> · office · decision · accepted · high · importance high · turn turn-1 · Keep Office run reducers in app-server.</span></div><div class="office-run-actions"><button type="button">Cancel</button><button type="button">Dispatch next</button></div></article><article class="office-run-row" data-status="failed"><div class="office-run-top"><strong>Previous attempt</strong><span class="office-run-status" data-status="failed">Failed</span></div><p class="office-run-meta">turn turn-0 · 10:05</p><p class="office-run-detail">Tool approval timed out</p><div class="office-run-actions"><button type="button">Retry</button></div></article></div></section><section class="activity-card activity-approvals"><div class="activity-card-head"><h2>Approvals inbox</h2><span class="approvals-count" data-empty="true">0</span></div><p class="activity-empty">No pending approvals.</p><div class="approval-list"></div></section><section class="activity-card activity-budget"><div class="activity-card-head"><h2>Usage &amp; budget</h2><span>$0.42 / $8</span></div><div class="budget-cap"><div class="budget-cap-bar"><span style="width:5%" data-warn="false"></span></div><span class="budget-cap-label">5% of daily budget used</span></div><div class="budget-list"><div class="budget-row"><span class="budget-glyph" data-accent="slate" aria-hidden="true">O</span><div class="budget-row-main"><div class="budget-row-top"><span class="budget-name">Office team</span><span class="budget-cost">$0.42</span></div><div class="budget-bar"><span style="width:24%" data-warn="false"></span></div><span class="budget-tokens">12.0k tok / 50.0k tok</span></div></div></div></section><section class="activity-card activity-artifacts"><div class="activity-card-head"><h2>Artifacts</h2><span>1</span></div><div class="artifact-list"><button type="button" class="artifact-row"><span class="artifact-glyph" data-accent="green" aria-hidden="true">D</span><div class="artifact-body"><div class="artifact-top"><strong>delivery-plan.md</strong><span class="artifact-kind">Doc</span></div><p class="artifact-meta">Updated by Reviewer</p></div></button></div></section></div></div>"`,
    );
  });

  it("renders command and file evidence metadata for office runs", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={{
          approvals: [],
          artifacts: [],
          runs: [
            {
              id: "office-run-tool-evidence",
              title: "Verify tool evidence",
              status: "completed",
              verificationChecks: [
                {
                  check: "Run app-server tests",
                  status: "passed",
                  command: "just test -p crewon-app-server",
                  evidence: "Command completed: just test -p crewon-app-server",
                  itemId: "cmd-1",
                  exitCode: 0,
                  durationMs: 1234,
                  outputPreview: "4 passed",
                  outputSha256:
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                },
              ],
              evidence: [
                {
                  summary: "Command completed: just test",
                  status: "verified",
                  source: "commandExecution",
                  evidenceKind: "commandExecution",
                  itemId: "cmd-1",
                  command: "just test -p crewon-app-server",
                  exitCode: 0,
                  durationMs: 1234,
                  outputPreview: "4 passed",
                  outputSha256:
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                  sourceTurnId: "turn-manager",
                },
                {
                  summary: "File change applied: src/lib.rs",
                  status: "verified",
                  source: "fileChange",
                  evidenceKind: "fileChange",
                  itemId: "patch-1",
                  changeCount: 1,
                  changesSha256:
                    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
                  paths: ["src/lib.rs"],
                  member: "Engineer",
                  agentId: "agent-engineer",
                  delegationId: "delegation-1",
                  sourceTurnId: "turn-member",
                },
              ],
            },
          ],
        }}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onDelegationDispatchNext={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
      />,
    );

    expect(markup).toContain("Command");
    expect(markup).toContain("Run app-server tests");
    expect(markup).toContain("just test -p crewon-app-server");
    expect(markup).toContain("exit 0");
    expect(markup).toContain("1234ms");
    expect(markup).toContain("4 passed");
    expect(markup).toContain("out 0123456789ab");
    expect(markup).toContain("cmd-1");
    expect(markup).toContain("File change");
    expect(markup).toContain("src/lib.rs");
    expect(markup).toContain("1 file");
    expect(markup).toContain("diff abcdef012345");
    expect(markup).toContain("Engineer/agent-engineer");
    expect(markup).toContain("delegation-1");
    expect(markup).toContain("turn turn-member");
  });

  it("renders runnable verification gaps for office runs", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={{
          approvals: [],
          artifacts: [],
          runs: [
            {
              id: "office-run-verification-gaps",
              title: "Verify release",
              status: "completed",
              loop: {
                review: {
                  status: "needsReview",
                  nextAction: "runVerificationChecks",
                  acceptance: {
                    total: 1,
                    passed: 1,
                    failed: 0,
                    pending: 0,
                  },
                  evidence: {
                    total: 1,
                    verified: 1,
                    blocked: 0,
                  },
                  verification: {
                    total: 2,
                    passed: 0,
                    failed: 0,
                    pending: 2,
                    runnablePending: 1,
                    missingRunnablePending: 1,
                  },
                },
              },
              acceptanceCriteria: [
                {
                  criterion: "Release notes cover rollback behavior",
                  criterionId: "criteria-release-notes",
                  status: "passed",
                  evidence: "Command completed: just test",
                  verifiedByCheck: "Run smoke automation",
                },
              ],
              verificationChecks: [
                {
                  check: "Run smoke automation",
                  status: "pending",
                  automationId: "nightly-smoke",
                },
                {
                  check: "Confirm rollback notes",
                  status: "pending",
                },
              ],
            },
          ],
        }}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onDelegationDispatchNext={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
      />,
    );

    expect(markup).toContain("Run verification checks");
    expect(markup).toContain("Checks 0/2");
    expect(markup).toContain("Runnable 1");
    expect(markup).toContain("Needs runnable ref 1");
    expect(markup).toContain("criteria-release-notes");
    expect(markup).toContain("check Run smoke automation");
  });

  it("renders office loop completion gates", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={{
          approvals: [],
          artifacts: [],
          runs: [
            {
              id: "office-run-gate",
              title: "Gate release",
              status: "completed",
              loop: {
                stopConditions: [
                  {
                    condition: "acceptanceCriteriaDefined",
                    met: true,
                  },
                  {
                    condition: "verificationComplete",
                    met: false,
                  },
                  {
                    condition: "hasRetryBudget",
                    met: true,
                  },
                ],
              },
            },
          ],
        }}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
      />,
    );

    expect(markup).toContain("Completion gate");
    expect(markup).toContain("Criteria framed");
    expect(markup).toContain("Verification complete");
    expect(markup).toContain("Retry budget available");
    expect(markup).toContain("Met");
    expect(markup).toContain("Needed");
    expect(markup).toContain('data-met="false"');
  });

  it("renders auto-loop and recovery update reasons for office runs", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={{
          approvals: [],
          artifacts: [],
          runs: [
            {
              id: "office-run-auto-verification",
              title: "Verify release",
              status: "running",
              lastNotificationReason: "autoVerificationStarted",
              lastNotificationSourceThreadId: "verification-thread",
              lastNotificationSourceTurnId: "verification-turn",
            },
            {
              id: "office-run-recovery",
              title: "Recover release",
              status: "completed",
              lastNotificationReason: "historyRecovery",
              lastNotificationSourceThreadId: "manager-thread",
              lastNotificationSourceTurnId: "manager-turn",
            },
            {
              id: "office-run-sync",
              title: "Manual sync",
              status: "completed",
              lastNotificationReason: "synced",
            },
          ],
        }}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
      />,
    );

    expect(markup).toContain("Auto loop");
    expect(markup).toContain("Auto verification started");
    expect(markup).toContain("thread verification-thread");
    expect(markup).toContain("turn verification-turn");
    expect(markup).toContain("Recovery");
    expect(markup).toContain("History recovered");
    expect(markup).toContain("thread manager-thread");
    expect(markup).not.toContain("Run synced");
  });

  it("renders office loop retry limits", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={{
          approvals: [],
          artifacts: [],
          runs: [
            {
              id: "office-run-limit",
              title: "Repair release",
              status: "completed",
              loop: {
                iteration: 4,
                maxIterations: 4,
                phase: "correct",
                status: "iterationLimit",
                metrics: {
                  retryBudgetRemaining: 0,
                },
                review: {
                  status: "needsReview",
                  nextAction: "repairFailedCriteria",
                },
              },
            },
          ],
        }}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onRunRetry={vi.fn()}
      />,
    );

    expect(markup).toContain("Iteration 4/4");
    expect(markup).toContain("Retry budget 0");
    expect(markup).toContain("Limit reached");
  });

  it("renders office run cancel and retry busy states", () => {
    const cancelingMarkup = renderToStaticMarkup(
      <ActivityBoard
        data={activity}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
        pendingRunAction="cancel"
        pendingRunId="office-run-1"
      />,
    );
    const retryingMarkup = renderToStaticMarkup(
      <ActivityBoard
        data={activity}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
        pendingRunAction="retry"
        pendingRunId="office-run-0"
      />,
    );
    const runningChecksMarkup = renderToStaticMarkup(
      <ActivityBoard
        data={{
          approvals: [],
          artifacts: [],
          runs: [
            {
              id: "office-run-checks",
              title: "Verify release",
              status: "completed",
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
            },
          ],
        }}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onDelegationDispatchNext={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
        pendingRunAction="retry"
        pendingRunId="office-run-checks"
      />,
    );

    expect(cancelingMarkup).toContain(
      '<button type="button" disabled="">Canceling</button>',
    );
    expect(retryingMarkup).toContain(
      '<button type="button" disabled="">Retrying</button>',
    );
    expect(runningChecksMarkup).toContain(
      '<button type="button" disabled="">Running checks</button>',
    );
  });

  it("renders cancellation controls for active office child tasks", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={{
          approvals: [],
          artifacts: [],
          runs: [
            {
              id: "office-run-child-cancel",
              title: "Coordinate child work",
              status: "running",
              threadId: "office-thread",
              turnId: "manager-turn",
              verificationChecks: [
                {
                  check: "Run smoke automation",
                  status: "pending",
                  automationId: "smoke-automation",
                  automationThreadId: "automation-thread",
                  automationTurnId: "automation-turn",
                  dispatchStatus: "running",
                },
              ],
              delegations: [
                {
                  id: "delegation-review",
                  member: "Reviewer",
                  task: "Review runtime state",
                  status: "running",
                  threadId: "member-thread",
                  turnId: "member-turn",
                },
              ],
            },
          ],
        }}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onDelegationCancel={vi.fn()}
        onVerificationCancel={vi.fn()}
      />,
    );

    expect(markup).toContain("Run smoke automation");
    expect(markup).toContain("Review runtime state");
    expect(markup).toContain("office-run-signal-row");
    expect(markup.match(/<button type="button">Cancel<\/button>/g)).toHaveLength(
      2,
    );
  });

  it("renders retry controls for failed office delegations", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={{
          approvals: [],
          artifacts: [],
          runs: [
            {
              id: "office-run-delegation-retry",
              title: "Recover child work",
              status: "running",
              delegations: [
                {
                  id: "delegation-review",
                  agentId: "agent-reviewer",
                  member: "Reviewer",
                  status: "failed",
                  task: "Review runtime state",
                  threadId: "member-thread",
                  turnId: "member-turn",
                  error: "Tool approval timed out",
                },
              ],
            },
          ],
        }}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onDelegationDispatch={vi.fn()}
        onDelegationRetry={vi.fn()}
      />,
    );

    expect(markup).toContain("Tool approval timed out");
    expect(markup).toContain('<button type="button">Retry</button>');
    expect(markup).not.toContain('<button type="button">Dispatch</button>');
  });

  it("renders retry controls for failed office verification checks", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={{
          approvals: [],
          artifacts: [],
          runs: [
            {
              id: "office-run-verification-retry",
              title: "Recover verification",
              status: "completed",
              verificationChecks: [
                {
                  itemId: "verification-smoke",
                  automationId: "smoke-automation",
                  check: "Run smoke automation",
                  status: "failed",
                  dispatchStatus: "failed",
                  automationStatus: "failed",
                  automationTurnId: "automation-turn-old",
                  error: "Smoke failed",
                },
              ],
            },
          ],
        }}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onVerificationRetry={vi.fn()}
      />,
    );

    expect(markup).toContain("Run smoke automation");
    expect(markup).toContain("failed");
    expect(markup).toContain('<button type="button">Retry</button>');
    expect(markup).not.toContain('<button type="button">Cancel</button>');
  });
});
