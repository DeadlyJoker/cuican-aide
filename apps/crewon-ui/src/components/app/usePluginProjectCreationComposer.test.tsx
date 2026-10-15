// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePluginProjectCreationComposer } from "./usePluginProjectCreationComposer";
import type { CommandWorkspaceHostModule } from "./CommandWorkspaceHostModule";
import { deferred } from "../../lib/plugins/pluginUiLoader.test-support";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
});
function fixture() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  let state: ReturnType<typeof usePluginProjectCreationComposer>;
  const owner = {},
    launch =
      vi.fn<
        NonNullable<CommandWorkspaceHostModule["startProjectConversation"]>
      >(),
    module: CommandWorkspaceHostModule = {
      id: "drama",
      label: "AI 短剧",
      pluginId: "crewon.drama",
      content: null,
      startProjectConversation: launch,
    };
  function Harness({
    current,
    account,
  }: {
    current: CommandWorkspaceHostModule;
    account: object;
  }) {
    state = usePluginProjectCreationComposer(current, "zh", account);
    return state.room;
  }
  const render = async (current = module, account = owner) => {
    await act(async () =>
      root.render(<Harness current={current} account={account} />),
    );
  };
  return {
    node,
    launch,
    module,
    owner,
    render,
    get state() {
      return state!;
    },
  };
}
describe("project Send presentation reuses the shared message renderer", () => {
  it("shows the user's message immediately before project startup settles and serializes Send", async () => {
    const f = fixture(),
      gate = deferred<void>();
    f.launch.mockReturnValue(gate.promise);
    await f.render();
    act(() => f.state.submit("雨夜来信", "gpt-6.1-sol"));
    expect(f.node.textContent).toContain("雨夜来信");
    expect(f.node.querySelector('[role="status"]')).not.toBeNull();
    expect(f.state.busy).toBe(true);
    act(() => f.state.submit("duplicate"));
    expect(f.launch).toHaveBeenCalledExactlyOnceWith({
      content: "雨夜来信",
      modelId: "gpt-6.1-sol",
    });
    await act(async () => gate.resolve());
    expect(f.node.textContent).toBe("");
    expect(f.state.busy).toBe(false);
  });
  it("retries the original exact prompt without another composer and isolates other plugins and accounts", async () => {
    const f = fixture();
    f.launch
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValue(undefined);
    await f.render();
    await act(async () => f.state.submit("原始想法", "gpt-6.1-sol"));
    expect(f.node.querySelector('[role="alert"]')).not.toBeNull();
    expect(f.node.querySelector("textarea,input")).toBeNull();
    await f.render({ ...f.module, id: "travel", pluginId: "crewon.travel" });
    expect(f.node.textContent).toBe("");
    await f.render();
    expect(f.node.textContent).toContain("原始想法");
    await act(async () => f.node.querySelector("button")!.click());
    expect(f.launch.mock.calls).toEqual([
      [{ content: "原始想法", modelId: "gpt-6.1-sol" }],
      [{ content: "原始想法", modelId: "gpt-6.1-sol" }],
    ]);
    const old = deferred<void>();
    f.launch.mockReturnValueOnce(old.promise);
    act(() => f.state.submit("旧账号的想法"));
    await f.render(f.module, {});
    expect(f.node.textContent).toBe("");
    await act(async () => old.reject(new Error("late")));
    expect(f.node.textContent).toBe("");
  });
  it("only intercepts plugin entry Send, never an existing project's conversation", async () => {
    const f = fixture();
    await f.render();
    expect(f.state.eligible).toBe(true);
    await f.render({ ...f.module, conversationProjectId: "project" });
    expect(f.state.eligible).toBe(false);
    await f.render({ ...f.module, startProjectConversation: undefined });
    expect(f.state.eligible).toBe(false);
  });
});

it("a refreshed unfinished request is visible and inert until the user resumes the original prompt", async () => {
  const f = fixture(),
    original = { content: "刷新前的想法", modelId: "gpt-6.1-sol" };
  f.launch.mockResolvedValue(undefined);
  await f.render({ ...f.module, projectCreationDraft: original });
  expect(f.node.textContent).toContain(original.content);
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.state.busy).toBe(true);
  await act(async () => f.node.querySelector("button")!.click());
  expect(f.launch).toHaveBeenCalledExactlyOnceWith(original);
  expect(f.node.textContent).toBe("");
});
