import { describe, expect, it } from "vitest";

import { createDefaultAgentConfig } from "../agent-config/agentConfigDefaults";
import {
  mergeOfficeMemberAgentProfile,
  officeMemberAgentProfileId,
  readOfficeMemberAgentProfile,
  writeOfficeMemberAgentProfile,
} from "./officeMemberAgentProfile";

describe("Office member Agent profiles", () => {
  it("keeps each member profile isolated inside its Office", () => {
    expect(officeMemberAgentProfileId("office-1", "member-2")).toBe(
      "office-member:office-1:member-2",
    );
  });

  it("hydrates saved choices from the current capability inventory", () => {
    const inventory = createDefaultAgentConfig("zh");
    const saved = {
      ...inventory,
      name: "旧名称",
      mcp: inventory.mcp.map((option) => ({ ...option, enabled: false })),
      skills: inventory.skills.map((option) => ({ ...option, enabled: false })),
      knowledge: [
        {
          id: "/knowledge/design",
          name: "设计规范",
          glyph: "K",
          accent: "violet" as const,
          description: "12 个文档",
          enabled: true,
        },
      ],
    };

    expect(
      mergeOfficeMemberAgentProfile({
        agentId: "office-member:office-1:member-2",
        displayName: "质量验收",
        inventory,
        knowledge: {
          memories: [],
          sources: [
            {
              name: "设计规范",
              glyph: "K",
              accent: "violet",
              status: "indexed",
              meta: "14 个文档",
              path: "/knowledge/design",
            },
          ],
        },
        saved,
      }),
    ).toEqual({
      ...saved,
      agentId: "office-member:office-1:member-2",
      name: "质量验收",
      knowledge: [
        {
          id: "/knowledge/design",
          name: "设计规范",
          glyph: "K",
          accent: "violet",
          description: "14 个文档",
          enabled: true,
        },
      ],
    });
  });

  it("keeps member settings available when the local Agent service is offline", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const profile = {
      ...createDefaultAgentConfig("zh"),
      agentId: officeMemberAgentProfileId("office-1", "member-2"),
      name: "质量验收",
      systemPrompt: "先检查证据，再给出结论。",
      knowledge: [],
    };

    writeOfficeMemberAgentProfile(profile, storage);

    expect(readOfficeMemberAgentProfile(profile.agentId, storage)).toEqual(
      profile,
    );
  });
});
