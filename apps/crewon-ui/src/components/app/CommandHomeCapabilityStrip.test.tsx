import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommandHomeCapabilityStrip } from "./CommandHomeCapabilityStrip";
import { scenePresets } from "../../lib/scene/sceneCatalog";

describe("CommandHomeCapabilityStrip", () => {
  it("renders the migration-era task configuration hierarchy", () => {
    const markup = renderToStaticMarkup(
      <CommandHomeCapabilityStrip
        locale="zh"
        mode="implement"
        preset={scenePresets.code}
      />,
    );

    expect(markup).toContain("任务方式");
    expect(markup).toContain("生码");
    expect(markup).toContain("核心上下文");
    expect(markup).toContain("默认交付");
    expect(markup).toContain("推荐能力");
    expect(markup).toMatchSnapshot();
  });
});
