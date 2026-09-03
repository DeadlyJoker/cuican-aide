import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ComposerExecutionIntentControl,
  ComposerPlanReadonlyStatus,
} from "./ComposerExecutionIntentControl";

describe("ComposerExecutionIntentControl", () => {
  it("defaults both optional intents to unselected in an accessible group", () => {
    const markup = renderToStaticMarkup(
      <ComposerExecutionIntentControl
        locale="zh"
        value="none"
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="执行方式"');
    expect(markup).toContain(
      'aria-pressed="false" class="execution-intent-option" data-execution-intent="goal"',
    );
    expect(markup).toContain(
      'aria-pressed="false" class="execution-intent-option" data-execution-intent="plan"',
    );
    expect(markup).not.toContain("发送后将清除当前目标");
  });

  it("shows the selected Plan and explains its effect on an active Goal", () => {
    const markup = renderToStaticMarkup(
      <ComposerExecutionIntentControl
        hasActiveGoal
        locale="zh"
        value="plan"
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain(
      'aria-pressed="true" class="execution-intent-option" data-execution-intent="plan"',
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("发送后将清除当前目标");
  });

  it("renders Plan permission as a non-interactive forced read-only status", () => {
    const markup = renderToStaticMarkup(
      <ComposerPlanReadonlyStatus locale="zh" />,
    );

    expect(markup).toContain('data-permission-mode="plan-read-only"');
    expect(markup).toContain('aria-label="权限：强制只读"');
    expect(markup).toContain("强制只读");
    expect(markup).not.toContain("<button");
  });
});
