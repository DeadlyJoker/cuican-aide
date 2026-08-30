import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import { sidebarThreadTitle } from "./SidebarPresentation";

describe("sidebarThreadTitle", () => {
  it("turns a legacy Office identifier into a user-facing chat title", () => {
    const thread = {
      name: "CrewON Office Chat · office-version-1 · 产品交付办公室",
      preview: "",
    } as unknown as Thread;

    expect(sidebarThreadTitle(thread, "未命名会话")).toBe("💬 产品交付办公室");
  });
});
