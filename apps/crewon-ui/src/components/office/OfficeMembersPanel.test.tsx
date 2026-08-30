import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OfficeMembersPanel, recruitableAgentOptions } from "./OfficeMembersPanel";

describe("OfficeMembersPanel", () => {
  it("hides storage actions and presents deletion as an Office action", () => {
    const markup = renderToStaticMarkup(
      <OfficeMembersPanel
        actions={[
          { id: "open-thread", label: "打开后端线程", threadId: "thread-1" },
          {
            id: "open-path",
            label: "打开后端记录",
            pathToOpen: "/repo/.crewon/offices/office.json",
            pathKind: "file",
          },
          {
            id: "delete-config-file",
            label: "删除后端记录",
            pathToOpen: "/repo/.crewon/offices/office.json",
            domainConfigKind: "office",
            tone: "danger",
          },
        ]}
        locale="zh"
        onPanelAction={vi.fn()}
        workspace={{
          goal: "Ship safely",
          members: [],
          messages: [],
          tasks: [],
        }}
      />,
    );

    expect(markup).not.toContain("后端记录");
    expect(markup).not.toContain("后端线程");
    expect(markup).toContain("删除办公室");
    expect(markup).toMatchSnapshot();
  });

  it("offers an explicit identity upgrade for a legacy Office member", () => {
    const markup = renderToStaticMarkup(
      <OfficeMembersPanel
        actions={[
          { id: "recruit-agent", label: "招募成员", tone: "primary" },
        ]}
        locale="zh"
        onPanelAction={vi.fn()}
        recruitableAgents={[
          {
            accent: "blue",
            agentId: "agent-legacy",
            glyph: "旧",
            mcp: [],
            model: "gpt-5",
            models: ["gpt-5"],
            name: "旧成员",
            permission: "workspace-write",
            permissions: ["workspace-write"],
            role: "交付智能体",
            skills: [],
            systemPrompt: "Ship safely",
          },
        ]}
        workspace={{
          goal: "Ship safely",
          members: [
            {
              accent: "blue",
              agentId: "agent-legacy",
              glyph: "旧",
              name: "旧成员",
              role: "交付智能体",
              status: "等待身份升级",
            },
          ],
          messages: [],
          tasks: [],
        }}
      />,
    );

    expect(markup).toContain("升级成员身份");
    // The select menu only renders while open; the per-option upgrade hint is
    // asserted on the option builder instead of the static markup.
    expect(
      recruitableAgentOptions({
        agents: [
          {
            agentId: "agent-legacy",
            name: "旧成员",
            role: "交付智能体",
          } as Parameters<typeof recruitableAgentOptions>[0]["agents"][number],
        ],
        isZh: true,
        members: [
          { agentId: "agent-legacy" } as Parameters<
            typeof recruitableAgentOptions
          >[0]["members"][number],
        ],
      }),
    ).toEqual([
      expect.objectContaining({ detail: "交付智能体 · 需升级身份" }),
    ]);
    expect(markup).toContain("才可安全 @");
    expect(markup).toMatchSnapshot();
  });
});
