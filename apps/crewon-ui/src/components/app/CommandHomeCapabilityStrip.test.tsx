import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CommandHomeCapabilityStrip,
  commandSceneMayWrite,
} from "./CommandHomeCapabilityStrip";
import { scenePresets } from "../../lib/scene/sceneCatalog";

describe("CommandHomeCapabilityStrip", () => {
  it("keeps Goal and Plan visible, mutually exclusive, and outside the add menu", () => {
    const markup = renderToStaticMarkup(
      <CommandHomeCapabilityStrip
        intent="none"
        locale="zh"
        preset={scenePresets.code}
        resources={[
          {
            id: "knowledge:repo",
            kind: "knowledge",
            label: "知识库",
            title: "仓库规则",
          },
          {
            id: "skill:review",
            kind: "skill",
            label: "Skill",
            title: "代码审阅",
          },
        ]}
        risky={false}
        onIntentChange={() => undefined}
        onResourceSelect={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="任务意图"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('data-resource-kind="knowledge"');
    expect(markup).toContain('data-resource-kind="skill"');
    expect(markup).toMatchSnapshot();
  });

  it("marks only write-capable scene modes as risky", () => {
    expect([
      commandSceneMayWrite("code", "ask"),
      commandSceneMayWrite("code", "implement"),
      commandSceneMayWrite("design", "produce"),
      commandSceneMayWrite("office", "organize"),
    ]).toEqual([false, true, true, false]);
  });
});
