import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../../lib/domain/crewonDomain";
import { CommandOfficeCreateDialog } from "./CommandOfficeCreateDialog";

describe("CommandOfficeCreateDialog", () => {
  const agent: { config: AgentConfig; filePath: string } = {
    filePath: "/repo/.crewon/agents/reviewer.json",
    config: {
      agentId: "agent-reviewer",
      name: "产品审阅智能体",
      glyph: "审",
      accent: "blue",
      role: "PRD 风险与验收口径",
      model: "gpt-5",
      models: ["gpt-5"],
      permission: "request-approval",
      permissions: ["request-approval"],
      systemPrompt: "Review product delivery.",
      mcp: [],
      skills: [],
    },
  };

  it("snapshots the new in-place Office builder with real recruitable agents", () => {
    const markup = renderToStaticMarkup(
      <CommandOfficeCreateDialog
        agents={[agent]}
        busy={false}
        error={null}
        locale="zh"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(markup).toMatchSnapshot();
    expect(markup).toContain('id="team-office-create-modal"');
    expect(markup).toContain("负责的工作任务");
    expect(markup).toContain("产品审阅智能体");
    expect(markup).not.toContain("执行流程");
    expect(markup).not.toContain("组长拆解");
    expect(markup).not.toContain('value="设计交付办公室"');
  });

  it("snapshots the team builder", () => {
    const markup = renderToStaticMarkup(
      <CommandOfficeCreateDialog
        agents={[agent]}
        busy={false}
        error={null}
        locale="zh"
        supportsGoal={false}
        supportsRoleReuse
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(markup).toMatchSnapshot();
    expect(markup).toContain("首位成员担任组长");
    expect(markup).not.toContain("负责的工作任务");
  });
});
