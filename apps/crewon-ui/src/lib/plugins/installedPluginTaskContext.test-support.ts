import type { ExtensionTaskView, RunView, ThreadView } from "@crewon/contracts";
import { ControlApiClient } from "@crewon/control-client";
import { vi } from "vitest";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import type { InstalledPluginTaskReceiptEvent } from "./installedPluginTaskReceipt";
import type { InstalledPluginTaskPorts } from "./useInstalledPluginTaskContext.types";
import { uiLease } from "./pluginUiLoader.test-support";

export const TASK_CONTEXT_NOW = "2026-10-03T00:00:00.000Z";
export function taskContextThread(
  threadId = "thread-1",
  revision = 17,
): ThreadView {
  return {
    threadId,
    revision,
    title: "Named Control response fixture",
    status: "active",
    lastMessageSequence: 0,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: TASK_CONTEXT_NOW,
    updatedAt: TASK_CONTEXT_NOW,
    archivedAt: null,
    deletedAt: null,
  };
}
export function taskContextRun(runId: string, threadId = "thread-1"): RunView {
  return {
    runId,
    threadId,
    status: "running",
    revision: 1,
    lastSequence: 1,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default",
    purpose: "turn",
    workflowVersionBinding: null,
    goalBinding: null,
    outputRef: null,
    failure: null,
    createdAt: TASK_CONTEXT_NOW,
    updatedAt: TASK_CONTEXT_NOW,
    terminalAt: null,
  };
}
export function taskContextTask(
  runId = "run-1",
  patch: Partial<ExtensionTaskView> = {},
): ExtensionTaskView {
  return {
    runId,
    threadId: "thread-1",
    pluginId: "example.workbench",
    pluginVersion: "1.0.1",
    configurationRevision: 3,
    runStatus: "running",
    sourceRunId: null,
    operations: [
      {
        operationId: "11111111-1111-1111-1111-111111111111",
        sourceRunId: runId,
        status: "submitted",
        observedAt: TASK_CONTEXT_NOW,
        images: [],
      },
    ],
    truncated: false,
    ...patch,
  };
}
export function taskContextModule(
  serial = 1,
  requiresTasks = true,
): ControlPluginUiModule {
  const original = uiLease(serial);
  const lease = {
    ...original,
    descriptor: {
      ...original.descriptor,
      requires: requiresTasks
        ? [{ service: "crewon.tasks", apiVersion: "2", optional: true }]
        : [],
    },
  };
  const plugin = {
    descriptor: lease.descriptor,
    publicAssets: lease.publicAssets,
    selectionRevision: lease.selectionRevision,
    packageDigest: lease.packageDigest,
  };
  return {
    key: JSON.stringify([lease.descriptor.pluginId, lease.contributionId]),
    mountKey: JSON.stringify([
      lease.descriptor.pluginId,
      lease.contributionId,
      serial,
      lease.packageDigest,
    ]),
    title: "Installed task module",
    contributionId: lease.contributionId,
    plugin,
  };
}
export function taskContextReceipt(
  module = taskContextModule(),
  patch: Partial<InstalledPluginTaskReceiptEvent["receipt"]> = {},
): InstalledPluginTaskReceiptEvent {
  const lease = {
    ...uiLease(module.plugin.selectionRevision),
    ...module.plugin,
    contributionId: module.contributionId,
  };
  return {
    lease,
    receipt: {
      disposition: "committed",
      threadId: "thread-1",
      threadRevision: 8,
      runId: "run-1",
      messageId: "message-1",
      configurationRevision: 3,
      ...patch,
    },
  };
}
export function taskContextDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function taskContextJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
export function taskContextError(status: number, code: string): Response {
  return taskContextJson(
    {
      error: {
        category:
          status === 404
            ? "notFound"
            : status === 403
              ? "authorization"
              : "internal",
        code,
        requestId: "named-fixture-request",
      },
    },
    status,
  );
}
type Request = {
  path: string;
  method: string;
  body: unknown;
  key: string | null;
  signal: AbortSignal | null | undefined;
};

/** Genuine ControlApiClient parsing/session behavior with named deterministic HTTP responses; not a backend or authority proof. */
export function taskContextFixture() {
  const threads = new Map([
    ["thread-1", taskContextThread()],
    ["thread-2", taskContextThread("thread-2", 41)],
    ["prepared-thread", taskContextThread("prepared-thread", 23)],
  ]);
  const tasks = new Map<string, ExtensionTaskView>();
  const runs = new Map<string, RunView[]>();
  const requests: Request[] = [];
  const events: InstalledPluginTaskReceiptEvent[] = [];
  const listeners = new Set<(event: InstalledPluginTaskReceiptEvent) => void>();
  let sessionCurrent = true;
  let handler:
    | ((request: Request) => Response | Promise<Response> | undefined)
    | null = null;
  const client = new ControlApiClient({
    baseUrl: "https://control.task-context.fixture.invalid",
    origin: "https://app.task-context.fixture.invalid",
    accessToken: "named-session-fixture",
    csrfToken: "named-csrf-fixture",
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      const request = {
        path: parsed.pathname,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as unknown) : null,
        key: new Headers(init?.headers).get("idempotency-key"),
        signal: init?.signal,
      };
      requests.push(request);
      const handled = handler?.(request);
      if (handled) return await handled;
      if (request.path === "/api/v1/threads" && request.method === "POST")
        return taskContextJson({
          disposition: "committed",
          thread: taskContextThread("prepared-thread", 1),
        });
      const threadMatch = /^\/api\/v1\/threads\/([^/]+)$/u.exec(request.path);
      if (threadMatch) {
        const thread = threads.get(threadMatch[1]!);
        return thread
          ? taskContextJson({ thread, eventSequence: thread.revision })
          : taskContextError(404, "thread_not_found");
      }
      const runMatch = /^\/api\/v1\/threads\/([^/]+)\/runs$/u.exec(
        request.path,
      );
      if (runMatch)
        return taskContextJson({
          data: runs.get(runMatch[1]!) ?? [],
          nextCursor: null,
        });
      const taskMatch =
        /^\/api\/v1\/extensions\/example.workbench\/tasks\/([^/]+)$/u.exec(
          request.path,
        );
      if (taskMatch) {
        const task = tasks.get(taskMatch[1]!);
        return task
          ? taskContextJson({ task })
          : taskContextError(404, "extension_task_not_found");
      }
      throw new Error(`unexpected_named_task_context_request:${request.path}`);
    },
  });
  const adopt = vi.fn<
    InstalledPluginTaskPorts["runtime"]["adoptExtensionTask"]
  >(async () => undefined);
  const ports: InstalledPluginTaskPorts = {
    client,
    runtime: { adoptExtensionTask: adopt },
    assertSessionCurrent: () => {
      if (!sessionCurrent) throw new Error("named_session_withdrawn");
    },
    receiptSource: {
      snapshot: () => [...events],
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  return {
    ports,
    client,
    requests,
    threads,
    tasks,
    runs,
    events,
    adopt,
    setHandler(value: typeof handler) {
      handler = value;
    },
    withdraw() {
      sessionCurrent = false;
    },
    emit(event: InstalledPluginTaskReceiptEvent) {
      events.push(event);
      for (const listener of listeners) listener(event);
    },
    listeners,
  };
}
