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
        expect(markup).toContain("本地 App Server");
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

  it("snapshots the Control independent verification boundary", () => {
    const markup = renderToStaticMarkup(
      <CommandTeamCapabilityCreateDialog
        kind="workflow"
        workflowAgents={[
          {
            description: "执行产出",
            id: "agent-executor",
            modelName: "gpt-test",
            name: "本地执行 Agent",
            systemPrompt: "完成节点任务。",
          },
          {
            description: "独立验收",
            id: "agent-verifier",
            modelName: "gpt-test",
            name: "本地验证 Agent",
            systemPrompt: "独立检查证据。",
          },
        ]}
        workflowRequiresVerification
        workspaceCwd="/repo/control"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(markup).toContain("Verification · 独立验收");
    expect(markup).toContain("最后必须由独立 Verification 节点验收输出");
    expect(markup).toMatchSnapshot();
  });
});
