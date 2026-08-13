import type { ControlApiClient } from "@crewon/control-client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CommandWorkspaceGitStatus,
  CommandWorkspaceSearch,
  executeWorkspaceReadonly,
} from "./CommandWorkspaceReadonly";

type ReadonlyClient = Pick<ControlApiClient, "executeWorkspaceReadonly">;

describe("workspace native readonly workbench", () => {
  it("sends content search through the authoritative thread without binding input", async () => {
    const executeWorkspaceReadonlyRequest = vi.fn().mockResolvedValue({
      schemaVersion: "crewon.workspace-native-readonly-response.v0",
      operation: "contentSearch",
      matches: [
        { path: "src/App.tsx", line: 12, preview: "const App = () =>" },
      ],
      scannedFiles: 18,
      scannedBytes: 2048,
      truncated: false,
    });
    const request = {
      schemaVersion: "crewon.workspace-native-readonly-request.v0" as const,
      operation: "contentSearch" as const,
      query: "App",
      pathSegments: [],
      maxMatches: 100,
    };

    const state = await executeWorkspaceReadonly(
      {
        executeWorkspaceReadonly: executeWorkspaceReadonlyRequest,
      } as unknown as ReadonlyClient,
      "thread-authoritative",
      request,
      "zh",
    );

    expect(executeWorkspaceReadonlyRequest).toHaveBeenCalledWith(
      "thread-authoritative",
      request,
      { signal: undefined },
    );
    expect(state).toEqual({
      status: "ready",
      result: {
        schemaVersion: "crewon.workspace-native-readonly-response.v0",
        operation: "contentSearch",
        matches: [
          { path: "src/App.tsx", line: 12, preview: "const App = () =>" },
        ],
        scannedFiles: 18,
        scannedBytes: 2048,
        truncated: false,
      },
    });
  });

  it("fails closed without a client or current thread and hides backend errors", async () => {
    await expect(
      executeWorkspaceReadonly(
        null,
        null,
        {
          schemaVersion: "crewon.workspace-native-readonly-request.v0",
          operation: "gitStatus",
        },
        "zh",
      ),
    ).resolves.toEqual({
      status: "error",
      message: "无法读取当前工作区，请稍后重试。",
    });

    const client = {
      executeWorkspaceReadonly: vi
        .fn()
        .mockRejectedValue(new Error("secret backend path")),
    } as unknown as ReadonlyClient;
    const state = await executeWorkspaceReadonly(
      client,
      "thread-1",
      {
        schemaVersion: "crewon.workspace-native-readonly-request.v0",
        operation: "gitStatus",
      },
      "en",
    );
    expect(state).toEqual({
      status: "error",
      message: "The current workspace could not be read. Try again.",
    });
    expect(JSON.stringify(state)).not.toContain("secret backend path");
  });

  it("snapshots the search and Git status entry states", () => {
    const surfaces = {
      gitStatus: renderToStaticMarkup(
        <CommandWorkspaceGitStatus client={null} locale="zh" threadId={null} />,
      ),
      search: renderToStaticMarkup(
        <CommandWorkspaceSearch client={null} locale="zh" threadId={null} />,
      ),
    };

    expect(surfaces).toMatchSnapshot();
  });
});
