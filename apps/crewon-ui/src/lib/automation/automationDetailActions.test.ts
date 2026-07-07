import { describe, expect, it } from "vitest";

import type {
  AutomationReadResponse,
  AutomationRunsListResponse,
} from "../app-server/appServer";
import type {
  AutomationConfig,
  LibraryItem,
  LibraryItemAction,
  LibraryPanel,
} from "../domain/crewonDomain";
import { openAutomationDetailAction } from "./automationDetailActions";

type AutomationDetailAction = Extract<
  LibraryItemAction,
  { type: "automation-detail" }
>;

function panel(): LibraryPanel {
  return {
    kind: "automation",
    title: "Automations",
    subtitle: "Library",
    items: [],
  };
}

function automationConfig(
  overrides: Partial<AutomationConfig> = {},
): AutomationConfig {
  return {
    title: "Latest Automation",
    subtitle: "Latest schedule",
    body: "Latest body",
    prompt: "Run the latest automation",
    enabled: true,
    status: "ready",
    trigger: { type: "manual" },
    threadId: "thread-latest",
    ...overrides,
  };
}

function action(
  overrides: Partial<AutomationDetailAction> = {},
): AutomationDetailAction {
  return {
    type: "automation-detail",
    title: "Nightly Refactor",
    subtitle: "Daily",
    body: "Check frontend drift",
    prompt: "Review frontend architecture",
    threadId: "thread-1",
    configPath: "/repo/.crewon/automations/nightly.json",
    ...overrides,
  };
}

async function runAction(
  overrides: Partial<Parameters<typeof openAutomationDetailAction>[0]> = {},
) {
  let currentPanel: LibraryPanel | null = panel();
  const readRunItems: string[] = [];
  const listedRuns: string[] = [];
  const handled = await openAutomationDetailAction({
    action: action(),
    isConnected: true,
    listAutomationRuns: async (threadId) => {
      listedRuns.push(threadId);
      return { data: [], nextCursor: null };
    },
    locale: "en",
    readAutomationConfig: async () => null,
    readAutomationRunItems: async (threadId) => {
      readRunItems.push(threadId);
      return [
        {
          title: "Loaded history",
          meta: "from readAutomationRunItems",
          glyph: "✓",
          accent: "green",
        },
      ];
    },
    setLibraryPanel: (updater) => {
      currentPanel = updater(currentPanel);
    },
    ...overrides,
  });
  return { currentPanel, handled, listedRuns, readRunItems };
}

describe("automation detail actions", () => {
  it("renders local automation detail without backend reads when disconnected", async () => {
    let read = false;
    const { currentPanel, handled } = await runAction({
      isConnected: false,
      readAutomationConfig: async () => {
        read = true;
        return null;
      },
    });

    expect(handled).toBe(true);
    expect(read).toBe(false);
    expect(currentPanel).toMatchObject({
      title: "Nightly Refactor",
      subtitle: "Daily",
      body: "Check frontend drift",
    });
  });

  it("loads latest automation config and run records", async () => {
    const readResponse: AutomationReadResponse = {
      record: {
        filePath: "/repo/.crewon/automations/latest.json",
        savedAt: "2026-06-17T07:00:00.000Z",
        config: automationConfig(),
      },
    };
    const runsResponse: AutomationRunsListResponse = {
      data: [
        {
          filePath: "/repo/.crewon/automations/latest-runs/run.json",
          savedAt: 1,
          run: {
            runId: "run-1",
            automationTitle: "Latest Automation",
            threadId: "thread-latest",
            turnId: "turn-1",
            status: "completed",
            startedAt: 1,
            completedAt: 2,
            note: "ok",
            config: automationConfig(),
          },
        },
      ],
      nextCursor: null,
    };

    const runListCalls: string[] = [];
    const { currentPanel, handled, readRunItems } = await runAction({
      readAutomationConfig: async () => readResponse,
      listAutomationRuns: async (threadId) => {
        runListCalls.push(threadId);
        return runsResponse;
      },
    });

    expect(handled).toBe(true);
    expect(readRunItems).toEqual(["thread-latest"]);
    expect(runListCalls).toEqual(["thread-latest"]);
    expect(currentPanel).toMatchObject({
      title: "Latest Automation",
      subtitle: "Latest schedule",
      body: expect.stringContaining("Backend record: /repo/.crewon/automations/latest.json"),
      items: [
        expect.objectContaining({
          title: "Backend run history",
        }),
        expect.objectContaining({
          title: "Latest Automation",
          description: expect.stringContaining("Thread: thread-latest"),
        }),
      ],
    });
  });

  it("shows empty run items when there are no backend run records", async () => {
    const { currentPanel, handled, listedRuns } = await runAction();

    expect(handled).toBe(true);
    expect(listedRuns).toEqual(["thread-1"]);
    expect(currentPanel?.items).toEqual([
      {
        title: "No run history",
        meta: "Waiting for first run",
        description:
          "Run it once to write the request and result into the backend execution thread.",
        glyph: "◷",
        accent: "slate",
      },
    ]);
  });

  it("uses empty run items when latest config has no thread", async () => {
    const { currentPanel, handled, listedRuns, readRunItems } = await runAction({
      readAutomationConfig: async () => ({
        record: {
          filePath: "/repo/.crewon/automations/latest.json",
          savedAt: "2026-06-17T07:00:00.000Z",
          config: automationConfig({ threadId: undefined }),
        },
      }),
    });

    expect(handled).toBe(true);
    expect(readRunItems).toEqual([]);
    expect(listedRuns).toEqual([]);
    expect(currentPanel?.items).toEqual([
      {
        title: "No run history",
        meta: "Waiting for first run",
        description:
          "Run it once to write the request and result into the backend execution thread.",
        glyph: "◷",
        accent: "slate",
      },
    ]);
  });

  it("shows failures for automation detail hydration", async () => {
    const { currentPanel, handled } = await runAction({
      readAutomationConfig: async () => {
        throw new Error("automation failed");
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel).toMatchObject({
      error: "automation failed",
    });
  });
});
