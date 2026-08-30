import { describe, expect, it } from "vitest";

import type { OfficeConfig } from "../domain/crewonDomain";
import { isLegacyGeneratedOfficePlaceholder } from "./legacyOfficePlaceholder";

function config(overrides: Partial<OfficeConfig> = {}): OfficeConfig {
  return {
    title: "新办公室 22:54",
    subtitle: "新建办公室 · 配置阶段",
    workspace: {
      goal: "围绕「新办公室 22:54」进行多智能体协作，先配置成员，再启动群聊。",
      members: [],
      messages: [],
      tasks: [],
    },
    ...overrides,
  };
}

describe("legacy generated Office placeholders", () => {
  it("recognizes the complete removed quick-create signature", () => {
    expect(isLegacyGeneratedOfficePlaceholder(config())).toBe(true);
    expect(
      isLegacyGeneratedOfficePlaceholder({
        ...config(),
        title: "New office 10:54 PM",
        subtitle: "New office · configuration stage",
        workspace: {
          ...config().workspace,
          goal: 'Coordinate multi-agent work for "New office 10:54 PM". Configure members first, then start the group chat.',
        },
      }),
    ).toBe(true);
  });

  it("keeps user-defined Offices even when their title looks similar", () => {
    expect(
      isLegacyGeneratedOfficePlaceholder({
        ...config(),
        workspace: { ...config().workspace, goal: "交付真实产品版本" },
      }),
    ).toBe(false);
    expect(
      isLegacyGeneratedOfficePlaceholder({
        ...config(),
        title: "发布办公室",
      }),
    ).toBe(false);
  });
});
