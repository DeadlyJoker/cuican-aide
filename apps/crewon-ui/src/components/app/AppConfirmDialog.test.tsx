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

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("确认操作");
    expect(markup).toContain("重置全局记忆");
    expect(markup).toMatchInlineSnapshot(
      `"<div class="app-confirm-overlay" role="presentation"><section aria-labelledby="app-confirm-title" aria-modal="true" class="app-confirm-dialog" role="dialog"><div class="app-confirm-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg></div><div class="app-confirm-content"><h2 id="app-confirm-title">确认操作</h2><p>重置全局记忆会清除模型可复用的记忆状态。继续？</p></div><div class="app-confirm-actions"><button type="button">取消</button><button class="app-confirm-primary" type="button">继续</button></div></section></div>"`,
    );
  });
});
