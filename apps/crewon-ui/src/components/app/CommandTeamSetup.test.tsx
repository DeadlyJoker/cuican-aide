// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TeamView } from "./CommandWorkspaceViews";
vi.mock("./useDesktopModelSetup", () => ({ useDesktopModelSetup: () => true }));
it("replaces a dead retry action with model setup on a new desktop", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  const configure = vi.fn();
  const props = {
    active: true,
    officeRuntime: null,
    teamMode: "office",
    workflows: [],
    expertTeams: [],
    onConfigureModel: configure,
  } as unknown as ComponentProps<typeof TeamView>;
  try {
    await act(async () => root.render(<TeamView {...props} />));
    expect(node.textContent).toContain("这台电脑尚无可用的模型凭据");
    expect(node.textContent).not.toContain("立即重试");
    expect(node.innerHTML).toMatchSnapshot();
    await act(async () => node.querySelector("button")!.click());
    expect(configure).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
