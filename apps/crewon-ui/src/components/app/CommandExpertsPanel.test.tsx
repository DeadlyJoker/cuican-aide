import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ExpertTeamRecordReference } from "../../lib/experts/expertTeamRecord";
import { CommandExpertsPanel } from "./CommandExpertsPanel";

const record: ExpertTeamRecordReference = {
  filePath: "/repo/.crewon/experts/code-review.json",
  config: {
    expertsId: "experts-code-review",
    title: "代码交付专家团",
    goal: "审查当前改动，修复必要问题并给出可验证结果。",
    leader: {
      name: "交付组长",
      role: "澄清目标、分派任务并汇总结果",
      agentType: "worker",
    },
    experts: [
      {
        name: "仓库探索专家",
        role: "定位代码、依赖与风险",
        agentType: "explorer",
      },
      {
        name: "实现验证专家",
        role: "完成实现并运行验证",
        agentType: "worker",
      },
    ],
    recordRevision: "revision-1",
    workspaceKey: "/repo",
    ownerSubject: "user-1",
    tenantId: null,
    spaceId: null,
  },
};

describe("CommandExpertsPanel", () => {
  it("snapshots a real Experts record as one leader chat with background specialists", () => {
    const markup = renderToStaticMarkup(
      <CommandExpertsPanel records={[record]} onSelect={vi.fn()} />,
    );

    expect(markup).toContain("团长：交付组长");
    expect(markup).toContain("探索专家：仓库探索专家");
    expect(markup).toContain("执行专家：实现验证专家");
    expect(markup).not.toContain("办公室");
    expect(markup).toMatchSnapshot();
  });

  it("snapshots the honest empty Experts state", () => {
    const markup = renderToStaticMarkup(
      <CommandExpertsPanel records={[]} onSelect={vi.fn()} />,
    );

    expect(markup).toContain("还没有专家团");
    expect(markup).toMatchSnapshot();
  });
});
