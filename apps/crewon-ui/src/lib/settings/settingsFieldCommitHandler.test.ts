import { describe, expect, it } from "vitest";

import { settingsFieldCommitErrorText } from "./settingsFieldCommitHandler";

describe("settingsFieldCommitErrorText", () => {
  it("turns connection failures into an actionable product message", () => {
    expect(
      settingsFieldCommitErrorText(
        new Error("Local app-server is not connected"),
        "zh",
      ),
    ).toBe("当前更改未确认保存，请检查连接后重试。");
  });

  it("does not expose an unexpected internal error", () => {
    expect(
      settingsFieldCommitErrorText(
        new Error("config_write_failed: desktop.appearanceTheme"),
        "zh",
      ),
    ).toBe("这项设置暂时无法保存，请稍后重试。");
  });
});
