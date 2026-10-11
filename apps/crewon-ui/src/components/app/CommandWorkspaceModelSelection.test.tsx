// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detailThread } from "../../lib/thread/threadDetailCache.test-support";
import { transcriptFixture } from "../../lib/control-runtime/controlTranscriptWindow.test-support";
import { CommandWorkspace } from "./CommandWorkspace";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Props = ComponentProps<typeof CommandWorkspace>;
const noop = () => undefined;
const sol = "gpt-6.1-sol";
const astra = "gpt-6-astra";
const options = [
  { value: sol, label: sol, isDefault: true },
  { value: astra, label: astra },
];
const base: Props = {
  composerValue: "",
  connectionState: "connected",
  cwd: "",
  isSending: false,
  locale: "zh",
  modelOptions: options,
  platform: "mac",
  platformSnapshotLoader: async () => emptyAgentPlatformSnapshot,
  workMode: "office",
  workspaceAuthority: "control",
  onAttachContext: noop,
  onChangeComposerValue: noop,
  onModeChange: noop,
  onRetryConnection: noop,
  onSend: noop,
};
const threads = [detailThread("tab-a"), detailThread("tab-b")];
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(
    null,
    "",
    "/?surface=desktop&platform=mac&os=mac#view-command",
  );
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.classList.remove("modal-open");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function render(threadId: string, overrides: Partial<Props> = {}) {
  const thread = threads.find((candidate) => candidate.id === threadId)!;
  await act(async () =>
    root.render(
      <CommandWorkspace
        {...base}
        linkedThreads={threads}
        selectedThread={thread}
        selectedThreadId={threadId}
        {...overrides}
      />,
    ),
  );
}

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () =>
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

function modelTrigger() {
  return container.querySelector<HTMLButtonElement>(
    'form[data-command-composer] button[aria-label="模型"]',
  )!;
}

async function chooseModel(modelId: string) {
  await click(modelTrigger());
  await click(
    document.querySelector(`[role="option"][data-value="${modelId}"]`),
  );
}

describe("CommandWorkspace conversation model selection", () => {
  it("restores each conversation's choice when switching and refreshing", async () => {
    await render("tab-b");
    await chooseModel(astra);
    expect(modelTrigger().textContent).toContain(astra);
    await render("tab-a");
    expect(modelTrigger().textContent).toContain(sol);
    await render("tab-b");
    expect(modelTrigger().textContent).toContain(astra);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render("tab-b");
    expect(modelTrigger().textContent).toContain(astra);
  });

  it("preserves manual choice as catalog defaults change and rejects a removed model", async () => {
    await render("tab-b");
    await chooseModel(astra);
    await render("tab-b", { modelOptions: [...options] });
    expect(modelTrigger().textContent).toContain(astra);
    await render("tab-b", { modelOptions: [options[0]!] });
    expect(modelTrigger().textContent).toContain(sol);
  });

  it("starts a new task with the catalog default and restores the retained conversation", async () => {
    await render("tab-b");
    await chooseModel(astra);
    await click(container.querySelector('[data-action="new-task"]'));
    expect(modelTrigger().textContent).toContain(sol);
    await click(container.querySelector('[data-linked-thread-id="tab-b"]'));
    expect(modelTrigger().textContent).toContain(astra);
  });

  it("publishes and submits the restored model instead of another conversation's choice", async () => {
    const send = vi.fn();
    const publish = vi.fn();
    await render("tab-b", { onComposerModelSelectionChange: publish });
    await chooseModel(astra);
    await render("tab-a", {
      composerValue: "Hello from A",
      onSend: send,
      onComposerModelSelectionChange: publish,
    });
    expect(publish).toHaveBeenLastCalledWith(sol);
    await act(async () =>
      container
        .querySelector("form[data-command-composer]")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(send).toHaveBeenCalledWith(
      "Hello from A",
      expect.objectContaining({ model: sol }),
    );
  });

  it("restores a draft's submitted model under the accepted new conversation after refreshing", async () => {
    const fixture = transcriptFixture(0);
    const draftModel = "model-1";
    const draftOptions = [...options, { value: draftModel, label: draftModel }];
    let accepted: Promise<unknown> | undefined;
    const sendNew: NonNullable<Props["onSendNewThread"]> = (text, settings) => {
      accepted = fixture.runtime.startTurn("thread-1", text, [], settings);
    };
    try {
      await render("tab-b", {
        modelOptions: draftOptions,
        onSendNewThread: sendNew,
      });
      await chooseModel(astra);
      await click(container.querySelector('[data-action="new-task"]'));
      await chooseModel(draftModel);
      await render("tab-b", {
        modelOptions: draftOptions,
        onSendNewThread: sendNew,
        composerValue: "Independent draft request",
      });
      await act(async () => {
        container
          .querySelector("form[data-command-composer]")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        await accepted;
      });
      expect(accepted).toBeDefined();
      await act(async () => root.unmount());
      root = createRoot(container);
      const newThread = detailThread("thread-1");
      await act(async () =>
        root.render(
          <CommandWorkspace
            {...base}
            modelOptions={draftOptions}
            selectedThread={newThread}
            selectedThreadId={newThread.id}
          />,
        ),
      );
      expect(modelTrigger().textContent).toContain(draftModel);
      await render("tab-b", { modelOptions: draftOptions });
      expect(modelTrigger().textContent).toContain(astra);
    } finally {
      fixture.runtime.close();
    }
  });
});
