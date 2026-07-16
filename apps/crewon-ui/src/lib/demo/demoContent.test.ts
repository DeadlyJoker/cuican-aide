import { describe, expect, it } from "vitest";

import { demoLibraryPanel } from "./demoContent";

describe("demoLibraryPanel Office boundary", () => {
  it("does not expose the legacy fictional Office catalog", () => {
    expect(demoLibraryPanel("office", "zh")).toEqual({
      kind: "office",
      title: "办公室",
      subtitle: "需要真实 App Server",
      body: "办公室只展示当前工作空间中由 App Server 返回的真实配置、成员、消息和运行状态。演示模式不会创建或展示虚构办公室。",
      actions: [],
      items: [],
    });
  });
});
