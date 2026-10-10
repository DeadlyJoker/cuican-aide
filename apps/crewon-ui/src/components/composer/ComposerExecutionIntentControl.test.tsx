import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ComposerExecutionIntentControl,
  ComposerPlanReadonlyStatus,
} from "./ComposerExecutionIntentControl";

describe("ComposerExecutionIntentControl", () => {
  it("hides intents until one is selected from the add menu", () => {
    expect(
      renderToStaticMarkup(
        <ComposerExecutionIntentControl
          locale="zh"
          value="none"
          onSelect={() => undefined}
        />,
      ),
    ).toBe("");
  });

  it.each(["goal", "plan"] as const)(
    "shows only the selected %s with a removal control",
    (value) => {
      const markup = renderToStaticMarkup(
        <ComposerExecutionIntentControl
          locale="zh"
          value={value}
          onSelect={() => undefined}
        />,
      );
      expect(markup.match(/data-execution-intent=/g)).toHaveLength(1);
      expect(markup).toContain(`data-execution-intent="${value}"`);
      expect(markup).toContain(
        value === "goal" ? 'aria-label="取消目标"' : 'aria-label="取消计划"',
      );
    },
  );

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
