import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentPlatformApiKeyDialog } from "./AgentPlatformApiKeyDialog";

describe("AgentPlatformApiKeyDialog", () => {
  it("uses a password field and explains the origin-scoped secure boundary", () => {
    const markup = renderToStaticMarkup(
      <AgentPlatformApiKeyDialog
        busy={false}
        error={null}
        locale="zh"
        origin="https://platform.example"
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(markup).toContain('type="password"');
    expect(markup).toContain("仅含 chat 权限");
    expect(markup).toContain("设置过期时间");
    expect(markup).toContain("https://platform.example");
    expect(markup).toContain("不会写入 Agent、数据库或运行清单");
    expect(markup).not.toContain("crewon-agent-platform-token");
    expect(markup).toContain("首次调用时验证");
  });

  it("blocks Runtime-changing saves while a known task is running", () => {
    const markup = renderToStaticMarkup(
      <AgentPlatformApiKeyDialog
        blockedReason="任务运行中，完成后再配置 PIM Key 或加入云智能体"
        busy={false}
        error={null}
        locale="zh"
        origin="https://platform.example"
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(markup).toContain("任务运行中，完成后再配置");
    expect(markup).toContain('disabled="" type="submit"');
  });
});
