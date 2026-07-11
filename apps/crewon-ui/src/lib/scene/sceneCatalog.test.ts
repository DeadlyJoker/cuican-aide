import { describe, expect, it } from "vitest";

import {
  executionTargetOptions,
  executionTargetOptionsFromDomain,
  modeMayWrite,
  scenePresets,
} from "./sceneCatalog";

describe("sceneCatalog", () => {
  it("defines distinct modes, context, deliverables, and quick actions", () => {
    expect(scenePresets.office).not.toEqual(scenePresets.code);
    expect(scenePresets.code).not.toEqual(scenePresets.design);
    expect(scenePresets.office.modes.map((mode) => mode.value)).toEqual([
      "auto",
      "organize",
      "write",
      "analyze",
      "coordinate",
    ]);
    expect(scenePresets.code.modes.map((mode) => mode.value)).toEqual([
      "auto",
      "ask",
      "plan",
      "implement",
      "review",
    ]);
    expect(scenePresets.design.modes.map((mode) => mode.value)).toEqual([
      "auto",
      "explore",
      "refine",
      "produce",
      "inspect",
    ]);
  });

  it("exposes persisted Agents and only ready Teams as execution targets", () => {
    const options = executionTargetOptionsFromDomain({
      agents: [{
        filePath: "/repo/.crewon/agents/reviewer.json",
        config: {
          agentId: "agent-reviewer",
          name: "审阅智能体",
          role: "检查实现风险",
        } as never,
      }],
      offices: [
        {
          filePath: "/repo/.crewon/offices/delivery.json",
          config: {
            title: "交付小队",
            workspace: { members: [{ name: "Builder" }] },
          } as never,
        },
        {
          filePath: "/repo/.crewon/offices/empty.json",
          config: {
            title: "空小队",
            workspace: { members: [] },
          } as never,
        },
      ],
      status: "ready",
    });

    expect(options).toMatchObject([
      { value: "crewon", strategy: "single" },
      { value: "agent:agent-reviewer", strategy: "single" },
      { value: "team:交付小队", strategy: "team" },
      { value: "team:空小队", strategy: "team", disabled: true },
    ]);
  });

  it("defaults to CrewON and exposes only real active agents", () => {
    const options = executionTargetOptions({
      agents: [
        { id: 1, is_active: true, name: "产品审阅" },
        { id: 2, is_active: false, name: "已停用" },
      ],
      knowledgeBases: [],
      mcpServers: [],
      mcpTools: [],
      skills: [],
      workflows: [],
    });

    expect(options).toEqual([
      {
        detail: "本地 Agent，独立完成任务",
        kind: "crewon",
        label: "CrewON",
        strategy: "single",
        value: "crewon",
      },
      {
        detail: "智能体定义已同步，Execution Target Runtime 尚未接入",
        disabled: true,
        kind: "agent",
        label: "产品审阅 · 单 Agent",
        strategy: "single",
        value: "agent:1",
      },
      {
        detail: "服务端 Team Runtime 与小队目录尚未接入",
        disabled: true,
        kind: "team",
        label: "选择已有小队 · 暂不可用",
        strategy: "team",
        value: "team:unavailable",
      },
    ]);
  });

  it("marks only write-capable modes for the draft-only risk notice", () => {
    expect(modeMayWrite("implement")).toBe(true);
    expect(modeMayWrite("produce")).toBe(true);
    expect(modeMayWrite("review")).toBe(false);
    expect(modeMayWrite("auto")).toBe(false);
  });
});
