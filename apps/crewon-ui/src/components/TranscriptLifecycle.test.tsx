// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import { Transcript } from "./Transcript";
import * as messages from "./TranscriptMessage";

const labels = {
  commandLabel: "Command",
  crewonLabel: "CrewON",
  emptyDescription: "Start",
  emptyTitle: "Ready",
  filesLabel: "Files",
  loadingLabel: "Loading",
  modeCodeDescription: "Code",
  modeCodeLabel: "Code",
  modeOfficeDescription: "Office",
  modeOfficeLabel: "Office",
  modeTitleLabel: "Mode",
  planLabel: "Plan",
  reasoningLabel: "Reasoning",
  stopLabel: "Stop",
  youLabel: "You",
};

function fixture({ turns = 1, actions = 2 } = {}): Thread {
  return {
    id: "lifecycle-thread",
    turns: Array.from({ length: turns }, (_, index) => ({
      id: `turn-${index}`,
      status: "completed",
      durationMs: 2_000,
      items: [
        {
          id: `user-${index}`,
          type: "userMessage",
          content: [{ type: "text", text: `Request ${index}` }],
        },
        ...Array.from({ length: actions }, (_, action) => ({
          id: `tool-${index}-${action}`,
          type: "commandExecution",
          command: `echo ${action}`,
          aggregatedOutput: `output-${action}`,
          status: "completed",
          exitCode: 0,
          durationMs: 10,
        })),
        {
          id: `answer-${index}`,
          type: "agentMessage",
          phase: "final_answer",
          text: `Answer **${index}**`,
          memoryCitation: null,
        },
      ],
    })),
  } as unknown as Thread;
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Transcript resource lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  function render(thread: Thread, streamingText = "") {
    act(() =>
      root.render(
        <Transcript
          {...labels}
          thread={thread}
          streamingText={streamingText}
          locale="en"
          mode="code"
          onModeChange={() => {}}
          onStop={() => {}}
        />,
      ),
    );
  }
  function toggleProcess() {
    act(() =>
      container
        .querySelector<HTMLButtonElement>(".turn-process-summary")!
        .click(),
    );
  }
  function toggleActions(open: boolean) {
    const details = container.querySelector<HTMLDetailsElement>(
      ".process-action-group",
    )!;
    act(() => {
      details.open = open;
      details.dispatchEvent(new Event("toggle"));
    });
  }
  const toolCards = () =>
    container.querySelectorAll("[data-kind=commandExecution]");

  it("does not mount a thousand collapsed tool cards or their output", () => {
    render(fixture({ actions: 1_000 }));
    expect(toolCards()).toHaveLength(0);
    expect(container.querySelectorAll(".message")).toHaveLength(2);
    expect(container.textContent).toContain("Answer 0");
    expect(container.textContent).not.toContain("output-");
    toggleProcess();
    expect(container.textContent).toContain("Ran multiple commands");
    expect(toolCards()).toHaveLength(0);
  });

  it("mounts actions only while open and releases them after the collapse animation", () => {
    vi.useFakeTimers();
    render(fixture());
    toggleProcess();
    expect(toolCards()).toHaveLength(0);
    toggleActions(true);
    expect(toolCards()).toHaveLength(2);
    expect(container.textContent!.indexOf("output-0")).toBeLessThan(
      container.textContent!.indexOf("output-1"),
    );
    toggleActions(false);
    expect(toolCards()).toHaveLength(0);
    toggleActions(true);
    toggleProcess();
    expect(
      container
        .querySelector(".turn-process-details")
        ?.getAttribute("data-state"),
    ).toBe("collapsing");
    expect(toolCards()).toHaveLength(2);
    act(() => vi.advanceTimersByTime(260));
    expect(toolCards()).toHaveLength(0);
    expect(
      container
        .querySelector(".turn-process-items-shell")
        ?.hasAttribute("hidden"),
    ).toBe(true);
    toggleProcess();
    toggleActions(true);
    expect(container.textContent).toContain("output-1");
  });

  it("cancels a pending collapse when reopened and when changing threads", () => {
    vi.useFakeTimers();
    render(fixture());
    toggleProcess();
    toggleActions(true);
    toggleProcess();
    act(() => vi.advanceTimersByTime(100));
    toggleProcess();
    act(() => vi.advanceTimersByTime(300));
    expect(toolCards()).toHaveLength(2);
    expect(
      container
        .querySelector(".turn-process-summary")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    toggleProcess();
    render({ ...fixture(), id: "another-thread", turns: [] });
    act(() => vi.runAllTimers());
    expect(toolCards()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps historical Markdown projections during a hundred streaming updates", () => {
    const combine = vi.spyOn(messages, "combineAgentMessages");
    const history = fixture({ turns: 80 });
    render(history);
    expect(combine).toHaveBeenCalledTimes(80);
    const firstAnswer = container.querySelector("[data-message-id=answer-0]");
    for (let delta = 1; delta <= 100; delta++)
      render(history, `Working ${delta}`);
    expect(combine).toHaveBeenCalledTimes(80);
    expect(container.querySelector("[data-message-id=answer-0]")).toBe(
      firstAnswer,
    );
    expect(container.textContent).toContain("Working 100");
    const changed = {
      ...history,
      turns: history.turns.map((turn, index) =>
        index === 0
          ? {
              ...turn,
              items: turn.items.map(
                (item): ThreadItem =>
                  item.type === "agentMessage"
                    ? { ...item, text: "Corrected answer" }
                    : item,
              ),
            }
          : turn,
      ),
    };
    render(changed);
    expect(combine).toHaveBeenCalledTimes(81);
    expect(container.textContent).toContain("Corrected answer");
  });

  it("shows a new running action and releases completed grouped cards", () => {
    const completed = fixture();
    const running: Thread = {
      ...completed,
      turns: completed.turns.map((turn) => ({
        ...turn,
        status: "inProgress",
        items: turn.items.map(
          (item): ThreadItem =>
            item.type === "commandExecution"
              ? { ...item, status: "inProgress" }
              : item,
        ),
      })),
    };
    render(running);
    expect(toolCards()).toHaveLength(2);
    render(completed);
    expect(toolCards()).toHaveLength(0);
    render(running);
    expect(toolCards()).toHaveLength(2);
  });
});
