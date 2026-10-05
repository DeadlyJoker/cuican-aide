// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import {
  useCommandWorkspaceHostModules,
  CommandWorkspaceHostModulePane,
} from "./CommandWorkspaceHostModule";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});
const module = {
  id: "short-drama/workbench",
  label: "AI 短剧",
  content: <p>项目工作台</p>,
};
type Request = Readonly<{ id: string; requestKey: string }> | null;
function Host({
  scope,
  request,
  available = true,
}: {
  scope: string;
  request: Request;
  available?: boolean;
}) {
  const selection = useCommandWorkspaceHostModules(available ? [module] : [], {
    navigationScope: scope,
    request,
  });
  return (
    <>
      <button onClick={selection.close}>关闭模块</button>
      <CommandWorkspaceHostModulePane
        module={module}
        active={selection.active}
      />
    </>
  );
}
it("opens only a new explicit host request and does not reopen after closing, scope switching or removal", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const request = { id: module.id, requestKey: "original-user-click" };
  const pane = () =>
    container!.querySelector<HTMLElement>("[data-host-module-id]")!;
  const render = async (scope: string, next: Request, available = true) => {
    await act(() =>
      root!.render(<Host scope={scope} request={next} available={available} />),
    );
  };
  await render("chat-a", null);
  expect(pane().hidden).toBe(true);
  await render("chat-a", request);
  expect(pane().hidden).toBe(false);
  await act(() => container!.querySelector("button")!.click());
  expect(pane().hidden).toBe(true);
  await render("chat-a", { ...request });
  expect(pane().hidden).toBe(true);
  await render("chat-b", request);
  expect(pane().hidden).toBe(true);
  await render("chat-a", request);
  expect(pane().hidden).toBe(true);
  await render("chat-a", { ...request, requestKey: "new-user-click" });
  expect(pane().hidden).toBe(false);
  await render("chat-a", { ...request, requestKey: "new-user-click" }, false);
  expect(pane().hidden).toBe(true);
});
