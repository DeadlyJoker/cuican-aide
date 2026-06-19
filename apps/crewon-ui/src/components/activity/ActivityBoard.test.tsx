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
      plan: [
        { step: "Index every run", status: "completed" },
        { step: "Wire cancel and retry", status: "inProgress" },
      ],
      delegations: [
        {
          member: "Reviewer",
          agentId: "agent-reviewer",
          task: "Review reducer behavior",
          status: "running",
          threadId: "thread-reviewer",
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
  it("renders office run controls and structured reducer output", () => {
    const markup = renderToStaticMarkup(
      <ActivityBoard
        data={activity}
        locale="en"
        onArtifact={vi.fn()}
        onDecision={vi.fn()}
        onRunCancel={vi.fn()}
        onRunRetry={vi.fn()}
      />,
    );

    expect(markup).toContain("Ship office backend");
    expect(markup).toContain("Land a real Office Agent team execution loop.");
    expect(markup).toContain("Wire cancel and retry");
    expect(markup).toContain("agent-reviewer");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Retry");
    expect(markup).toMatchInlineSnapshot(`"<div class="activity-board"><section class="activity-card activity-trace"><div class="activity-card-head"><h2>Execution trace</h2><span>Live</span></div><ol class="trace-timeline"><li class="trace-step" data-status="done"><span class="trace-glyph" data-accent="blue" aria-hidden="true">P</span><div class="trace-body"><div class="trace-top"><strong>Planner</strong><span class="trace-action">Planned</span><span class="trace-time">10:12</span></div><p class="trace-detail">Split the delivery work into implementation and review.</p><div class="trace-meta"><span class="trace-status" data-status="done">Done</span><span class="trace-tokens">4.2k tok</span></div></div></li></ol></section><div class="activity-rail"><section class="activity-card activity-runs"><div class="activity-card-head"><h2>Team runs</h2><span>2</span></div><div class="office-run-list"><article class="office-run-row" data-status="running"><div class="office-run-top"><strong>Ship office backend</strong><span class="office-run-status" data-status="running">Running</span></div><p class="office-run-meta">turn turn-1 · 10:14</p><p class="office-run-goal"><span>Goal</span>Land a real Office Agent team execution loop.</p><p class="office-run-detail">Implement index, reducer, cancel, retry, and UI.</p><ol class="office-run-plan"><li data-status="completed"><span>Done</span><strong>Index every run</strong></li><li data-status="inProgress"><span>Running</span><strong>Wire cancel and retry</strong></li></ol><div class="office-run-delegations"><span><strong>Reviewer</strong> · agent-reviewer · Review reducer behavior · running</span></div><div class="office-run-actions"><button type="button">Cancel</button></div></article><article class="office-run-row" data-status="failed"><div class="office-run-top"><strong>Previous attempt</strong><span class="office-run-status" data-status="failed">Failed</span></div><p class="office-run-meta">turn turn-0 · 10:05</p><p class="office-run-detail">Tool approval timed out</p><div class="office-run-actions"><button type="button">Retry</button></div></article></div></section><section class="activity-card activity-approvals"><div class="activity-card-head"><h2>Approvals inbox</h2><span class="approvals-count" data-empty="true">0</span></div><p class="activity-empty">No pending approvals.</p><div class="approval-list"></div></section><section class="activity-card activity-budget"><div class="activity-card-head"><h2>Usage &amp; budget</h2><span>$0.42 / $8</span></div><div class="budget-cap"><div class="budget-cap-bar"><span style="width:5%" data-warn="false"></span></div><span class="budget-cap-label">5% of daily budget used</span></div><div class="budget-list"><div class="budget-row"><span class="budget-glyph" data-accent="slate" aria-hidden="true">O</span><div class="budget-row-main"><div class="budget-row-top"><span class="budget-name">Office team</span><span class="budget-cost">$0.42</span></div><div class="budget-bar"><span style="width:24%" data-warn="false"></span></div><span class="budget-tokens">12.0k tok / 50.0k tok</span></div></div></div></section><section class="activity-card activity-artifacts"><div class="activity-card-head"><h2>Artifacts</h2><span>1</span></div><div class="artifact-list"><button type="button" class="artifact-row"><span class="artifact-glyph" data-accent="green" aria-hidden="true">D</span><div class="artifact-body"><div class="artifact-top"><strong>delivery-plan.md</strong><span class="artifact-kind">Doc</span></div><p class="artifact-meta">Updated by Reviewer</p></div></button></div></section></div></div>"`);
  });
});
