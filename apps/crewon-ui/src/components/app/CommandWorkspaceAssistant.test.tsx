import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommandWorkspaceAssistant } from "./CommandWorkspaceAssistant";

describe("assistant workspace", () => {
  it("exposes the schedule bridge without leaking legacy service wording", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspaceAssistant
        active
        activeTurnId={null}
        clearAvailable={false}
        composer={<div>Composer</div>}
        locale="zh"
        streamingText=""
        thread={null}
        workMode="code"
        onCreateSchedule={() => {}}
        onModeChange={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="创建日程"');
    expect(markup).toContain("当前输入会自动带入");
    expect(markup).not.toContain("App Server");
    expect(markup).toMatchSnapshot();
  });
});
