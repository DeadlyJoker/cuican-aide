import type { ControlApiClient } from "@crewon/control-client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CommandWorkspaceGitStatus,
  CommandWorkspaceSearch,
  executeWorkspaceReadonly,
  WorkspaceReadonlyRequestGuard,
  type WorkspaceReadonlyState,
} from "./CommandWorkspaceReadonly";

type ReadonlyClient = Pick<ControlApiClient, "executeWorkspaceReadonly">;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const gitRequest = {
  schemaVersion: "crewon.workspace-native-readonly-request.v0" as const,
  operation: "gitStatus" as const,
};

function gitResponse(branch: string) {
  return {
    schemaVersion: "crewon.workspace-native-readonly-response.v0" as const,
    operation: "gitStatus" as const,
    branch,
    head: null,
    entries: [],
    truncated: false,
  };
}

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

  it("does not let an old thread response overwrite the current Git status request", async () => {
    const oldResponse = deferred<ReturnType<typeof gitResponse>>();
    const currentResponse = deferred<ReturnType<typeof gitResponse>>();
    const client = {
      executeWorkspaceReadonly: vi
        .fn()
        .mockReturnValueOnce(oldResponse.promise)
        .mockReturnValueOnce(currentResponse.promise),
    } as unknown as ReadonlyClient;
    const guard = new WorkspaceReadonlyRequestGuard();
    let committed: WorkspaceReadonlyState<ReturnType<typeof gitResponse>> = {
      status: "loading",
    };

    const oldRequest = guard.begin();
    const oldState = executeWorkspaceReadonly<ReturnType<typeof gitResponse>>(
      client,
      "thread-old",
      gitRequest,
      "zh",
      oldRequest.controller.signal,
    );
    const currentRequest = guard.begin();
    expect(oldRequest.controller.signal.aborted).toBe(true);
    const currentState = executeWorkspaceReadonly<
      ReturnType<typeof gitResponse>
    >(
      client,
      "thread-current",
      gitRequest,
      "en",
      currentRequest.controller.signal,
    );

    currentResponse.resolve(gitResponse("current"));
    const currentResult = await currentState;
    if (guard.isCurrent(currentRequest)) committed = currentResult;
    oldResponse.resolve(gitResponse("old"));
    const oldResult = await oldState;
    if (guard.isCurrent(oldRequest)) committed = oldResult;

    expect(committed).toEqual({
      status: "ready",
      result: gitResponse("current"),
    });
    expect(client.executeWorkspaceReadonly).toHaveBeenNthCalledWith(
      2,
      "thread-current",
      gitRequest,
      { signal: currentRequest.controller.signal },
    );
  });

  it("does not commit a deferred error after the component request is disposed", async () => {
    const response = deferred<ReturnType<typeof gitResponse>>();
    const client = {
      executeWorkspaceReadonly: vi.fn().mockReturnValue(response.promise),
    } as unknown as ReadonlyClient;
    const guard = new WorkspaceReadonlyRequestGuard();
    const request = guard.begin();
    let committed: WorkspaceReadonlyState<ReturnType<typeof gitResponse>> = {
      status: "loading",
    };
    const pendingState = executeWorkspaceReadonly<
      ReturnType<typeof gitResponse>
    >(client, "thread-unmounted", gitRequest, "zh", request.controller.signal);

    guard.dispose();
    response.reject(new Error("late failure"));
    const nextState = await pendingState;
    if (guard.isCurrent(request)) committed = nextState;

    expect(request.controller.signal.aborted).toBe(true);
    expect(nextState.status).toBe("error");
    expect(committed).toEqual({ status: "loading" });
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
