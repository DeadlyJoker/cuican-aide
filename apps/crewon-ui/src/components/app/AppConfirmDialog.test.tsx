import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppConfirmDialog } from "./AppConfirmDialog";

describe("AppConfirmDialog", () => {
  it("renders an application confirmation dialog", () => {
    const markup = renderToStaticMarkup(
      <AppConfirmDialog
        locale="zh"
        request={{ message: "重置全局记忆会清除模型可复用的记忆状态。继续？" }}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("确认操作");
    expect(markup).toContain("重置全局记忆");
    expect(markup).toMatchSnapshot();
  });
});
