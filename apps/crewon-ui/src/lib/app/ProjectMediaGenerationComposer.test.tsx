// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ProjectMediaGenerationComposer } from "./ProjectMediaGenerationComposer";
import {
  fixture,
  binding,
  savedInput,
  receipt,
} from "../control-runtime/controlProjectMediaGeneration.test-support";
import { deferred } from "../control-runtime/controlProjectMediaInputStage.test-support";
const environment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previous = environment.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = previous;
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function view() {
  const f = fixture(),
    container = document.createElement("div"),
    root = createRoot(container),
    changed = vi.fn();
  document.body.append(container);
  const render = async (zh = true) => {
    await act(async () => {
      root.render(
        <StrictMode>
          <textarea aria-label="聊天草稿" defaultValue="保留我的后续想法" />
          <ProjectMediaGenerationComposer
            client={f.client}
            binding={binding}
            briefRevision={1}
            presenter={f.presenter}
            busy={false}
            zh={zh}
            onBusyChange={changed}
          />
        </StrictMode>,
      );
    });
  };
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
    f.controller.dispose();
  });
  await render();
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find(
      (b) => b.textContent === name,
    )!;
  const select = async () => {
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = savedInput.mediaInputId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  return { ...f, container, render, changed, button, select };
}
it("renders within the original slot, survives StrictMode, and leaves the chat draft and host theme intact", async () => {
  const f = await view();
  expect(f.posts).toHaveLength(0);
  await f.select();
  expect(f.button("生成画面").disabled).toBe(false);
  expect(f.container.querySelector("details")?.outerHTML).toMatchSnapshot();
  const theme = document.documentElement.getAttribute("data-theme");
  await act(async () => {
    await f.button("生成画面").click();
  });
  expect(f.posts).toHaveLength(1);
  expect(f.presenter.adoptExtensionTask).toHaveBeenCalledOnce();
  await f.render(false);
  expect(f.container.textContent).toContain(
    "Task accepted in this project conversation",
  );
  expect(f.container.querySelector("textarea")?.value).toBe("保留我的后续想法");
  expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
  expect(f.container.querySelectorAll("style")).toHaveLength(0);
});
it("shows stop waiting during preparation and reports busy state without submitting a chat Turn", async () => {
  const f = await view();
  await f.select();
  const gate = deferred<Response>();
  f.setPost(() => gate.promise);
  await act(async () => {
    f.button("生成画面").click();
  });
  expect(f.posts).toHaveLength(1);
  expect(f.changed).toHaveBeenCalledWith(true);
  expect(f.button("停止等待")).toBeDefined();
  await act(async () => {
    f.button("停止等待").click();
    gate.resolve(Response.json(receipt(f.posts[0]!)));
  });
  expect(f.presenter.adoptExtensionTask).not.toHaveBeenCalled();
  expect(f.changed).toHaveBeenLastCalledWith(false);
  expect(f.container.querySelector("textarea")?.value).toBe("保留我的后续想法");
});
