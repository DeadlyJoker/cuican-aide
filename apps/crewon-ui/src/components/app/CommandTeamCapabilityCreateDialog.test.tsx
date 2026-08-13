import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandTeamCapabilityCreateDialog } from "./CommandTeamCapabilityCreateDialog";

describe("CommandTeamCapabilityCreateDialog", () => {
  it.each(["workflow" as const, "experts" as const])(
    "snapshots the %s creation boundary",
    (kind) => {
      const workspaceCwd =
        kind === "workflow" ? "/repo/team" : "/repo/single-chat";
    const markup = renderToStaticMarkup(
      <CommandTeamCapabilityCreateDialog
        kind={kind}
        workflowAgents={[
          {
            description: "审阅需求",
            id: "agent-product-review",
            modelName: "qwen-plus",
            name: "产品审阅智能体",
            systemPrompt: "严格审阅需求。",
          },
          {
            description: "交付检查",
            id: "agent-delivery",
            modelName: "qwen-plus",
            name: "交付智能体",
            systemPrompt: "检查交付质量。",
          },
        ]}
        workspaceCwd={workspaceCwd}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

      if (kind === "workflow") {
        expect(markup).toContain("本地执行边界");
        expect(markup).toContain("CrewON Control");
        expect(markup).toContain("执行节点");
        expect(markup).toContain("Human Gate · 人工确认");
        expect(markup).toContain("产品审阅智能体");
        expect(markup).toContain("交付智能体");
        expect(markup).toContain(workspaceCwd);
        expect(markup).not.toContain("API 未启用");
      } else {
        expect(markup).toContain("团长单聊工作空间");
        expect(markup).toContain(workspaceCwd);
      }
    expect(markup).toMatchSnapshot();
    },
  );
});
