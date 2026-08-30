import { describe, expect, it } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import type { AutomationConfig } from "./crewonDomain";
import {
  appAutomationConfigRecordsToLibraryItems,
  readAppAutomationRunItems,
  runAppAutomationConfig,
  updateAppAutomationRun,
  writeAppAutomationConfig,
} from "./domainAutomationBackend";

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function automationConfig(
  overrides: Partial<AutomationConfig> = {},
): AutomationConfig {
  return {
    title: "Daily summary",
    subtitle: "Automation",
    body: "Summarize work",
    prompt: "Summarize today's work",
    threadId: "thread-1",
    ...overrides,
  };
}

describe("domain automation backend", () => {
  it("skips app automation config writes when the backend workspace is unavailable", async () => {
    await expect(
      writeAppAutomationConfig({
        client: client({
          async saveAutomationConfig() {
            throw new Error("unexpected save");
          },
        }),
        config: automationConfig(),
        resolveBackendCwd: async () => "",
      }),
    ).resolves.toBeNull();
  });

  it("writes an app automation config through the resolved backend workspace", async () => {
    const config = automationConfig();
    const captures: unknown[] = [];
    const result = await writeAppAutomationConfig({
      client: client({
        async saveAutomationConfig(cwd, nextConfig) {
          captures.push({ cwd, nextConfig });
          return { filePath: ".crewon/automations/daily.json" };
        },
      }),
      config,
      resolveBackendCwd: async () => "/repo",
    });

    expect(captures).toEqual([{ cwd: "/repo", nextConfig: config }]);
    expect(result).toBe(".crewon/automations/daily.json");
  });

  it("returns a workspace warning when an app automation run has no backend workspace", async () => {
    const result = await runAppAutomationConfig({
      client: null,
      config: automationConfig(),
      locale: "en",
      note: "manual run",
      resolveBackendCwd: async () => "",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      record: null,
      warning:
        "The automation run continued, but no backend workspace is available, so run history was not recorded.",
    });
  });

  it("runs an app automation config through the backend workspace", async () => {
    const captures: unknown[] = [];
    const result = await runAppAutomationConfig({
      client: client({
        async runAutomationConfig(cwd, config, note, turnId) {
          captures.push({ cwd, config, note, turnId });
          return {
            filePath: ".crewon/automations/daily.json",
            run: {
              runId: "run-1",
            },
          } as Awaited<ReturnType<AppServerClient["runAutomationConfig"]>>;
        },
      }),
      config: automationConfig(),
      locale: "en",
      note: "manual run",
      resolveBackendCwd: async () => "/repo",
      turnId: "turn-1",
    });

    expect(captures).toEqual([
      {
        cwd: "/repo",
        config: automationConfig(),
        note: "manual run",
        turnId: "turn-1",
      },
    ]);
    expect(result).toEqual({
      record: {
        filePath: ".crewon/automations/daily.json",
        runId: "run-1",
      },
      warning: null,
    });
  });

  it("updates an app automation run through the backend workspace", async () => {
    const captures: unknown[] = [];
    await updateAppAutomationRun({
      client: client({
        async updateAutomationRun(cwd, filePath, status, completedAt) {
          captures.push({ cwd, filePath, status, completedAt });
          return {
            filePath,
            run: {
              automationTitle: "Daily summary",
              completedAt,
              config: automationConfig(),
              note: null,
              runId: "run-1",
              startedAt: 100,
              status,
              threadId: "thread-1",
              turnId: "turn-1",
            },
          };
        },
      }),
      completedAt: 123,
      filePath: ".crewon/automations/daily.json",
      resolveBackendCwd: async () => "/repo",
      status: "completed",
    });

    expect(captures).toEqual([
      {
        completedAt: 123,
        cwd: "/repo",
        filePath: ".crewon/automations/daily.json",
        status: "completed",
      },
    ]);
  });

  it("returns empty run items without resolving workspace when no thread is bound", async () => {
    const items = await readAppAutomationRunItems({
      client: client(),
      locale: "zh",
      resolveBackendCwd: async () => {
        throw new Error("unexpected resolve");
      },
      threadId: null,
    });

    expect(items).toMatchObject([
      {
        title: "暂无运行记录",
        meta: "等待首次运行",
      },
    ]);
  });

  it("adds backend run items to app automation config records", async () => {
    const items = await appAutomationConfigRecordsToLibraryItems({
      client: client({
        async listAutomationRuns(cwd, threadId) {
          expect({ cwd, threadId }).toEqual({
            cwd: "/repo",
            threadId: "thread-1",
          });
          return {
            data: [
              {
                filePath: ".crewon/automations/runs/run-1.json",
                savedAt: 123,
                run: {
                  automationTitle: "Daily summary",
                  completedAt: 123,
                  config: automationConfig(),
                  note: "manual run",
                  runId: "run-1",
                  startedAt: 100,
                  status: "completed",
                  threadId: "thread-1",
                  turnId: "turn-1",
                },
              },
            ],
            nextCursor: null,
          };
        },
      }),
      locale: "en",
      records: [
        {
          config: automationConfig(),
          filePath: ".crewon/automations/daily.json",
          savedAt: "2026-01-02T03:04:05Z",
        },
      ],
      resolveBackendCwd: async () => "/repo",
    });

    expect(items[0]).toMatchObject({
      title: "Daily summary",
      action: {
        items: [
          {
            title: "Backend run history",
          },
          {
            title: "Daily summary",
            meta: expect.stringContaining("Completed"),
          },
        ],
        threadId: "thread-1",
        type: "automation-detail",
      },
    });
  });
});
