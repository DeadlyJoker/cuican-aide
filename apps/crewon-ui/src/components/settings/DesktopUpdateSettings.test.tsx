import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { UpdateState } from "../../lib/update/desktopUpdate";
import {
  DesktopUpdateSettings,
  DesktopUpdateSettingsView,
} from "./DesktopUpdateSettings";

describe("DesktopUpdateSettings", () => {
  it("does not resolve or check the updater while Settings is only being opened", () => {
    const resolvePort = vi.fn();

    const markup = renderToStaticMarkup(
      <DesktopUpdateSettings locale="zh" resolvePort={resolvePort} />,
    );

    expect(resolvePort).not.toHaveBeenCalled();
    expect(markup).toContain('data-desktop-update="idle"');
    expect(markup).toContain("检查更新");
    expect(markup).not.toContain("安装并重启");
  });

  it("snapshots the user-visible update states and explicit actions", () => {
    const states: UpdateState[] = [
      { phase: "unsupported" },
      { phase: "checking" },
      { phase: "current" },
      {
        phase: "available",
        version: "0.3.0",
        notes: "修复恢复流程\n改进设置体验",
      },
      {
        phase: "downloading",
        version: "0.3.0",
        progress: 0.625,
      },
      { phase: "ready", version: "0.3.0" },
      { phase: "failed", error: "签名校验失败" },
    ];

    const markup = renderToStaticMarkup(
      <div>
        {states.map((state) => (
          <DesktopUpdateSettingsView
            key={state.phase}
            locale="zh"
            state={state}
            onCheck={vi.fn()}
            onInstall={vi.fn()}
          />
        ))}
      </div>,
    );

    expect(markup).toContain("CrewON 已是最新版本");
    expect(markup).toContain("CrewON 0.3.0 可安装");
    expect(markup).toContain("安装并重启");
    expect(markup).toContain('value="0.625"');
    expect(markup).toContain('role="alert"');
    expect(markup).toMatchSnapshot();
  });
});
