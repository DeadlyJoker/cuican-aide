import { describe, expect, it } from "vitest";

import {
  executionTargetGroups,
  executionTargetOptionsFromDomain,
  modeMayWrite,
  scenePresets,
} from "./sceneCatalog";

describe("sceneCatalog", () => {
  it("labels mixed Office and Experts execution targets as Teams", () => {
    expect({
      en: executionTargetGroups("en"),
      zh: executionTargetGroups("zh"),
    }).toMatchSnapshot();
  });

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
      agents: [
        {
          filePath: "/repo/.crewon/agents/reviewer.json",
          config: {
            agentId: "agent-reviewer",
            name: "审阅智能体",
            role: "检查实现风险",
          } as never,
        },
      ],
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

  it("keeps duplicate Office titles visible but non-selectable and uniquely keyed", () => {
    const options = executionTargetOptionsFromDomain({
      agents: [],
      offices: [
        {
          filePath: "/repo/.crewon/offices/a.json",
          config: {
            title: "同名办公室",
            workspace: { members: [{ name: "A" }] },
          } as never,
        },
        {
          filePath: "/repo/.crewon/offices/b.json",
          config: {
            title: "同名办公室",
            workspace: { members: [{ name: "B" }] },
          } as never,
        },
      ],
      status: "ready",
    });
    const teams = options.filter((option) => option.kind === "team");

    expect(teams).toHaveLength(2);
    expect(new Set(teams.map((option) => option.value)).size).toBe(2);
    expect(teams).toEqual([
      expect.objectContaining({
        disabled: true,
        detail: "存在同名办公室，需先在办公室配置中改为唯一名称",
      }),
      expect.objectContaining({
        disabled: true,
        detail: "存在同名办公室，需先在办公室配置中改为唯一名称",
      }),
    ]);
  });

  /*
   * A cloud agent can be saved twice on disk: once as the resource id
   * `agent-platform:agents:<id>` and once as a bare `agent-platform:<id>`. Both
   * are real shapes in existing workspaces, and keying the dedupe on the raw
   * value listed the same agent twice under the same name.
   */
  it("lists a cloud agent once when both saved id shapes exist", () => {
    const options = executionTargetOptionsFromDomain({
      agents: [
        {
          filePath: "/repo/.crewon/agents/new.json",
          config: {
            agentId: "agent-platform:agents:7",
            name: "数据分析助手",
          } as never,
        },
        {
          filePath: "/repo/.crewon/agents/legacy.json",
          config: {
            agentId: "agent-platform:7",
            name: "数据分析助手",
          } as never,
        },
      ],
      offices: [],
      status: "ready",
    });

    expect(options.filter((option) => option.kind === "agent")).toEqual([
      expect.objectContaining({
        group: "single",
        label: "数据分析助手",
        value: "agent:agent-platform:agents:7",
      }),
    ]);
  });

  it("groups single agents apart from teams and drops repeated suffixes", () => {
    const options = executionTargetOptionsFromDomain({
      agents: [
        {
          filePath: "/repo/.crewon/agents/reviewer.json",
          config: { agentId: "agent-reviewer", name: "审阅员" } as never,
        },
      ],
      offices: [
        {
          filePath: "/repo/.crewon/offices/delivery.json",
          config: {
            title: "交付小队",
            workspace: { members: [{ name: "A" }] },
          } as never,
        },
      ],
      status: "ready",
    });

    // The section header carries the distinction, so the label is the name only.
    expect(
      options.map((option) => ({
        group: option.group,
        label: option.label,
      })),
    ).toEqual([
      { group: undefined, label: "CrewON" },
      { group: "single", label: "审阅员" },
      { group: "experts", label: "交付小队" },
    ]);
  });

  it("does not relabel Office records as Experts execution targets", () => {
    const options = executionTargetOptionsFromDomain({
      agents: [],
      offices: [
        {
          filePath: "/repo/.crewon/offices/review.json",
          config: {
            title: "审阅办公室",
            workspace: { members: [{ name: "Reviewer" }] },
          } as never,
        },
      ],
      status: "ready",
    });

    expect(options).toEqual([
      expect.objectContaining({ kind: "crewon", value: "crewon" }),
      expect.objectContaining({
        kind: "team",
        value: "team:审阅办公室",
      }),
    ]);
    expect(options.some((option) => option.kind === "experts")).toBe(false);
  });

  it("keeps inactive Control Office definitions visible but disabled", () => {
    const options = executionTargetOptionsFromDomain({
      agents: [],
      offices: [
        {
          config: { title: "内容运营办公室" },
          controlOffice: {
            memberCount: 3,
            officeVersionId: "office-version-1",
            runtimeStatus: "multiMember",
          },
          filePath: "control://offices/office-version-1",
        },
      ],
      status: "ready",
    });

    expect(options).toMatchSnapshot();
  });

  it("enables a single-member office with an active runtime", () => {
    const options = executionTargetOptionsFromDomain({
      agents: [],
      offices: [
        {
          config: { title: "内容运营办公室" },
          controlOffice: {
            memberCount: 1,
            officeVersionId: "office-version-1",
            runtimeStatus: "ready",
          },
          filePath: "control://offices/office-version-1",
        },
      ],
      status: "ready",
    });

    expect(options).toContainEqual(
      expect.objectContaining({
        disabled: false,
        detail: "1 名成员 · 已就绪",
        value: "team:office-version-1",
      }),
    );
  });

  it("marks only write-capable modes for the draft-only risk notice", () => {
    expect(modeMayWrite("implement")).toBe(true);
    expect(modeMayWrite("produce")).toBe(true);
    expect(modeMayWrite("review")).toBe(false);
    expect(modeMayWrite("auto")).toBe(false);
  });
});
