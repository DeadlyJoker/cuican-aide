import { describe, expect, it } from "vitest";

import type {
  AutomationConfig,
  LibraryItem,
  LibraryItemAction,
} from "../domain/crewonDomain";
import {
  automationDetailFailurePatch,
  automationDetailPanel,
  automationDetailItemsPatch,
  automationDetailPanelPatch,
  buildAutomationDetailPanel,
  matchingAutomationDetailFailurePanel,
  matchingAutomationDetailItemsPanel,
  matchingAutomationDetailPanel,
  matchingAutomationRunSyncedPanel,
  patchAutomationDetailPanelIfCurrent,
} from "./automationDetailPanel";

type AutomationDetailAction = Extract<
  LibraryItemAction,
  { type: "automation-detail" }
>;

function automationConfig(): AutomationConfig {
  return {
    title: "Nightly Refactor",
    subtitle: "Scheduled cleanup",
    body: "Runs frontend cleanup checks.",
    prompt: "Run cleanup",
  };
}

function automationAction(
  overrides: Partial<AutomationDetailAction> = {},
): AutomationDetailAction {
  return {
    type: "automation-detail",
    title: "Nightly Refactor",
    subtitle: "Scheduled cleanup",
    body: "Runs frontend cleanup checks.",
    prompt: "Run cleanup",
    ...overrides,
  };
}

describe("automation detail panel content", () => {
  it("builds automation detail lifecycle patches", () => {
    const panel = buildAutomationDetailPanel(automationAction(), "en");
    const items: LibraryItem[] = [{ title: "Run 1", meta: "completed" }];

    expect(automationDetailPanelPatch(panel)).toEqual({
      ...panel,
      error: undefined,
    });
    expect(automationDetailItemsPatch(items)).toEqual({
      items,
      error: undefined,
    });
    expect(automationDetailFailurePatch(null, "zh")).toEqual({
      error: "读取自动化运行记录失败",
    });
    expect(automationDetailFailurePatch(new Error("denied"), "en")).toEqual({
      error: "denied",
    });
    expect(
      automationDetailPanel(
        {
          kind: "automation",
          title: "Automations",
          subtitle: "Library",
          items: [],
          error: "old error",
        },
        panel,
      ),
    ).toEqual({
      kind: "automation",
      title: "Nightly Refactor",
      subtitle: "Scheduled cleanup",
      body: "Runs frontend cleanup checks.",
      actions: panel.actions,
      fields: panel.fields,
      items: panel.items,
      error: undefined,
    });
  });

  it("applies automation detail patches only to matching titles", () => {
    const panel = {
      kind: "automation" as const,
      title: "Nightly Refactor",
      subtitle: "Scheduled cleanup",
      items: [],
    };
    const patch = automationDetailItemsPatch([{ title: "Run 1", meta: "ok" }]);

    expect(
      patchAutomationDetailPanelIfCurrent(
        panel,
        ["Nightly Refactor", "Latest Refactor"],
        patch,
      ),
    ).toEqual({
      ...panel,
      ...patch,
    });
    expect(
      patchAutomationDetailPanelIfCurrent(panel, ["Other Refactor"], patch),
    ).toBe(panel);
    expect(
      patchAutomationDetailPanelIfCurrent(null, ["Nightly Refactor"], patch),
    ).toBeNull();
    expect(
      matchingAutomationDetailPanel(
        panel,
        ["Nightly Refactor"],
        buildAutomationDetailPanel(automationAction({ title: "Latest" }), "en"),
      ),
    ).toMatchObject({
      title: "Latest",
      error: undefined,
    });
    expect(
      matchingAutomationDetailItemsPanel(panel, ["Nightly Refactor"], [
        { title: "Run 2", meta: "ok" },
      ]),
    ).toEqual({
      ...panel,
      items: [{ title: "Run 2", meta: "ok" }],
      error: undefined,
    });
    expect(
      matchingAutomationDetailFailurePanel(
        panel,
        ["Nightly Refactor"],
        null,
        "en",
      ),
    ).toEqual({
      ...panel,
      error: "Unable to read automation run history",
    });
  });

  it("syncs automation run lifecycle into matching detail panels", () => {
    const panel = {
      kind: "automation" as const,
      title: "Nightly Refactor",
      subtitle: "Scheduled cleanup",
      body: "Runs frontend cleanup checks.",
      actions: [
        {
          id: "run-automation" as const,
          label: "Run now",
          automationThreadId: "thread-1",
        },
      ],
      items: [{ title: "Old run", meta: "old" }],
      error: "old error",
    };
    const items = [{ title: "Run 2", meta: "completed" }];

    expect(
      matchingAutomationRunSyncedPanel(panel, {
        items,
        lifecycleLines: ["Run completed", "Record: run-1"],
        threadId: "thread-1",
      }),
    ).toEqual({
      ...panel,
      body: "Runs frontend cleanup checks.\nRun completed\nRecord: run-1",
      items,
      error: undefined,
    });
    expect(
      matchingAutomationRunSyncedPanel(panel, {
        items,
        lifecycleLines: ["Run completed"],
        threadId: "other-thread",
      }),
    ).toBe(panel);
  });

  it("builds no-thread automation panels", () => {
    expect(buildAutomationDetailPanel(automationAction(), "en")).toEqual({
      title: "Nightly Refactor",
      subtitle: "Scheduled cleanup",
      body: "Runs frontend cleanup checks.",
      actions: [
        {
          id: "run-automation",
          label: "Run now",
          automationConfigPath: undefined,
          automationTitle: "Nightly Refactor",
          automationThreadId: undefined,
          automationPrompt: "Run cleanup",
          tone: "primary",
        },
      ],
      fields: [
        {
          id: "automation-run-note",
          label: "Run note",
          placeholder: "Optional: what should this run focus on",
          value: "",
        },
      ],
      items: [
        {
          title: "No backend thread",
          meta: "Created after the first run",
          description:
            "Run now to create a real execution thread and write the run history.",
          glyph: "◷",
          accent: "slate",
        },
      ],
    });
  });

  it("adds thread and backend record actions", () => {
    const config = automationConfig();

    expect(
      buildAutomationDetailPanel(
        automationAction({
          threadId: "thread-1",
          config,
          configPath: "/repo/.crewon/automations/nightly.json",
        }),
        "zh",
      ).actions,
    ).toEqual([
      {
        id: "open-thread",
        label: "打开后端线程",
        threadId: "thread-1",
      },
      {
        id: "run-automation",
        label: "立即运行",
        automationConfig: config,
        automationConfigPath: "/repo/.crewon/automations/nightly.json",
        automationTitle: "Nightly Refactor",
        automationThreadId: "thread-1",
        automationPrompt: "Run cleanup",
        tone: "primary",
      },
      {
        id: "open-path",
        label: "打开后端记录",
        pathToOpen: "/repo/.crewon/automations/nightly.json",
        pathKind: "file",
      },
      {
        id: "delete-config-file",
        label: "删除后端记录",
        pathToOpen: "/repo/.crewon/automations/nightly.json",
        pathKind: "file",
        domainConfigKind: "automation",
        tone: "danger",
      },
    ]);
  });

  it("uses provided items or override items instead of default placeholders", () => {
    const actionItems: LibraryItem[] = [{ title: "Existing run", meta: "done" }];
    const overrideItems: LibraryItem[] = [{ title: "Latest run", meta: "ok" }];

    expect(
      buildAutomationDetailPanel(
        automationAction({ items: actionItems, threadId: "thread-1" }),
        "en",
      ).items,
    ).toEqual(actionItems);

    expect(
      buildAutomationDetailPanel(
        automationAction({ items: actionItems, threadId: "thread-1" }),
        "en",
        overrideItems,
      ).items,
    ).toEqual(overrideItems);
  });
});
