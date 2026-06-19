import { describe, expect, it } from "vitest";

import {
  sideChatCreatedPanel,
  sideChatCreatingPanel,
  sideChatErrorPanel,
} from "./sideChatPanel";

describe("side chat panel helpers", () => {
  it("builds side chat lifecycle panels", () => {
    expect(sideChatCreatingPanel("en")).toEqual({
      title: "Side chat",
      subtitle: "Fork thread",
      body: "Creating...",
    });
    expect(sideChatCreatedPanel("thread-1", "zh")).toEqual({
      title: "侧边聊天",
      subtitle: "thread-1",
      body: "已创建分叉会话",
    });
    expect(sideChatErrorPanel(null, "en")).toEqual({
      title: "Side chat",
      subtitle: "Fork thread",
      error: "Unable to create side chat",
    });
    expect(sideChatErrorPanel(new Error("failed"), "zh")).toEqual({
      title: "侧边聊天",
      subtitle: "分叉会话",
      error: "failed",
    });
  });
});
