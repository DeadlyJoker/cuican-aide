import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createDefaultAgentConfig } from "../../lib/agent-config/agentConfigDefaults";
import type { OfficeMemberAgentProfile } from "../../lib/office/officeMemberAgentProfile";
import { ControlOfficeMemberAgentSettings } from "./ControlOfficeMemberAgentSettings";

describe("ControlOfficeMemberAgentSettings", () => {
  it("shows the member prompt and selectable capabilities", () => {
    const profile: OfficeMemberAgentProfile = {
      ...createDefaultAgentConfig("zh"),
      name: "质量验收",
      systemPrompt: "优先检查遗漏、风险和证据。",
      skills: [
        {
          id: "review",
          name: "交付审查",
          glyph: "审",
          accent: "violet",
          description: "检查交付内容是否完整",
          enabled: true,
        },
      ],
      mcp: [
        {
          id: "issues",
          name: "任务服务",
          glyph: "任",
          accent: "blue",
          description: "读取和更新团队任务",
          enabled: false,
        },
      ],
      knowledge: [
        {
          id: "delivery-guide",
          name: "交付规范",
          glyph: "规",
          accent: "green",
          description: "团队统一的交付要求",
          enabled: true,
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <ControlOfficeMemberAgentSettings
        error={null}
        loading={false}
        locale="zh"
        profile={profile}
        onChange={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(markup).toContain("系统提示词");
    expect(markup).toContain("优先检查遗漏、风险和证据。");
    expect(markup).toContain("Skill");
    expect(markup).toContain("MCP 服务");
    expect(markup).toContain("知识库");
    expect(markup).toContain("交付审查");
    expect(markup).toContain("任务服务");
    expect(markup).toContain("交付规范");
    expect(markup).toMatchSnapshot();
  });
});
