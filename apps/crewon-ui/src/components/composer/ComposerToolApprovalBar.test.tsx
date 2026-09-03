import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerToolApprovalBar } from "./ComposerToolApprovalBar";

const approval = {
  approvalId: "approval-1",
  busy: false,
  runId: "run-1",
  threadId: "thread-1",
  toolName: "workspace_run_command",
} as const;

describe("ComposerToolApprovalBar", () => {
  it("renders both decisions with the pending approval context", () => {
    const onDecision = vi.fn();
    const markup = renderToStaticMarkup(
      <ComposerToolApprovalBar
        approval={approval}
        locale="zh"
        onDecision={onDecision}
      />,
    );

    expect(markup).toContain('data-od-id="composer-tool-approval"');
    expect(markup).toContain("工具调用等待批准");
    expect(markup).toContain(
      "workspace_run_command 尚未开始执行，请先检查上方调用参数。",
    );
    expect(markup).toContain(">批准并继续</button>");
    expect(markup).toContain(">拒绝</button>");
    expect(markup).not.toContain("disabled");
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("disables decisions while the mutation is in flight and shows failures", () => {
    const markup = renderToStaticMarkup(
      <ComposerToolApprovalBar
        approval={{ ...approval, busy: true, error: "approval conflict" }}
        locale="zh"
        onDecision={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain("approval conflict");
  });
});
