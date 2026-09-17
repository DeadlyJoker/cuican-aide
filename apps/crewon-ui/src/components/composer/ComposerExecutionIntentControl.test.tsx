// @ts-expect-error Vitest runs this check in Node; the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ComposerExecutionIntentControl,
  ComposerPlanReadonlyStatus,
} from "./ComposerExecutionIntentControl";

describe("ComposerExecutionIntentControl", () => {
  it("preserves compact, theme-aware selected chips and visible keyboard focus", () => {
    const styles = readFileSync(
      new URL("./ComposerExecutionIntentControl.css", import.meta.url),
      "utf8",
    );
    expect(styles).toContain("button:focus-visible");
    expect(styles).toContain("var(--accent)");
    expect(styles).toContain("overflow-wrap: anywhere");
    expect(styles).toMatchSnapshot();
  });
  it("keeps both optional intents off the toolbar until selected", () => {
    const markup = renderToStaticMarkup(
      <ComposerExecutionIntentControl
        locale="zh"
        value="none"
        onClear={() => undefined}
      />,
    );

    expect(markup).toBe("");
  });

  it("shows the selected Plan and explains its effect on an active Goal", () => {
    const markup = renderToStaticMarkup(
      <ComposerExecutionIntentControl
        hasActiveGoal
        locale="zh"
        value="plan"
        onClear={() => undefined}
      />,
    );

    expect(markup).toContain('data-execution-intent="plan"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("发送后将清除当前目标");
    expect(markup).toContain('aria-label="取消计划"');
    expect(markup).not.toContain('data-execution-intent="goal"');
  });

  it.each(["goal", "plan"] as const)(
    "shows only the selected %s with an explicit remove action",
    (value) => {
      const markup = renderToStaticMarkup(
        <ComposerExecutionIntentControl
          locale="zh"
          value={value}
          onClear={() => undefined}
        />,
      );
      expect(markup.match(/data-execution-intent=/g)).toHaveLength(1);
      expect(markup).toContain(`data-execution-intent="${value}"`);
      expect(markup).toContain(
        `aria-label="取消${value === "goal" ? "目标" : "计划"}"`,
      );
      expect(markup).toMatchSnapshot();
    },
  );

  it("keeps an unsupported selection visible and removable instead of silently running normally", () => {
    const markup = renderToStaticMarkup(
      <ComposerExecutionIntentControl
        locale="zh"
        value="plan"
        blockedReason="当前团队不支持计划"
        onClear={() => undefined}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-blocked="true"');
    expect(markup).toContain('aria-label="取消计划"');
    expect(markup).not.toContain("disabled");
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
