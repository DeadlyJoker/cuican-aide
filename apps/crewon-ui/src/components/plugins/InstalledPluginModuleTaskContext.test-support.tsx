// @ts-expect-error This focused Vitest fixture reads an externally built artifact in Node; product UI has no filesystem API.
import { readFileSync } from "node:fs";
// @ts-expect-error Vitest's native ESM importer is a Node-only test fixture, outside the renderer API.
import { compileFunction, constants } from "node:vm";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import type {
  ExtensionTaskView,
  MessageView,
  RunEventView,
  RunView,
  ThreadView,
} from "@crewon/contracts";
import {
  parsePluginPackageDescriptor,
  parsePluginUiLease,
} from "@crewon/contracts/plugins";
import { ControlThreadRuntime } from "../../lib/control-runtime/controlThreadRuntime";
import { createControlPluginUiHost } from "../../lib/plugins/controlPluginUiHost";
import type { ControlPluginUiModule } from "../../lib/plugins/controlPluginUiCatalog";
import { createInstalledPluginTaskReceipts } from "../../lib/plugins/installedPluginTaskReceipts";
import type { InstalledPluginTaskPorts } from "../../lib/plugins/useInstalledPluginTaskContext.types";
import { deferred } from "../../lib/plugins/pluginUiLoader.test-support";
import { InstalledPluginModule } from "./InstalledPluginModule";

export const MODULE_TASK_NOW = "2026-10-03T00:00:00.000Z";
export const MODULE_TASK_OPERATION = "11111111-1111-1111-1111-111111111111";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function error(code: string) {
  return json(
    {
      error: {
        category: "notFound",
        code,
        requestId: "named-module-task-fixture",
      },
    },
    404,
  );
}
function sse(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", finish);
    controller.close();
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      if (signal?.aborted) finish();
      else signal?.addEventListener("abort", finish, { once: true });
    },
    cancel() {
      closed = true;
      signal?.removeEventListener("abort", finish);
    },
  });
  return {
    signal,
    finish,
    response: new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }),
    send(value: RunEventView) {
      if (closed) throw new Error("named_module_sse_closed");
      controller.enqueue(
        new TextEncoder().encode(
          `id: ${value.sequence}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
        ),
      );
    },
  };
}

async function hash(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
async function externalPackage() {
  const environment = (
    globalThis as unknown as {
      process: { env: Record<string, string | undefined> };
    }
  ).process.env;
  const directory = environment.CREWON_TEST_KREA_PLUGIN_DIR;
  if (!directory)
    throw new Error(
      "CREWON_TEST_KREA_PLUGIN_DIR_required_for_actual_package_test",
    );
  const root = new URL(`file://${directory.replace(/\/$/u, "")}/`);
  const descriptorBytes = new Uint8Array(
    readFileSync(new URL("crewon.plugin.json", root)),
  );
  const descriptor = parsePluginPackageDescriptor(
    JSON.parse(new TextDecoder().decode(descriptorBytes)),
  );
  for (const file of descriptor.files) {
    const bytes = new Uint8Array(readFileSync(new URL(file.path, root)));
    if (
      bytes.byteLength !== file.byteLength ||
      (await hash(bytes)) !== file.sha256
    )
      throw new Error("named_fixture_package_bytes_changed");
  }
  const packageDigest =
    "sha256:" +
    (await hash(
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: "crewon.local-plugin-package-identity.v1",
          descriptorSha256: await hash(descriptorBytes),
          directories: [],
          files: [...descriptor.files].sort((a, b) =>
            a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
          ),
        }),
      ),
    ));
  const entry = descriptor.entrypoints.ui;
  if (
    descriptor.pluginId !== "crewon.comfyui-krea2" ||
    entry?.mode !== "trustedModule"
  )
    throw new Error("named_fixture_krea_ui_missing");
  return {
    descriptor,
    packageDigest,
    entryUrl: new URL(entry.path, root).href,
  };
}

type Request = Readonly<{
  path: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Headers;
  signal?: AbortSignal | null;
}>;
/** Named HTTP response fixtures + actual external SDK UI, real client/loader/runtime/SSE. No server, payer or supplier is asserted. */
export async function installedModuleTaskFixture() {
  const artifact = await externalPackage();
  const lease = parsePluginUiLease({
    schemaVersion: "crewon.plugin-ui-lease.v1",
    mountRef: "module_fixture_" + "1".repeat(32),
    expiresAt: "2099-10-03T00:00:00.000Z",
    selectionRevision: 1,
    packageDigest: artifact.packageDigest,
    descriptor: artifact.descriptor,
    contributionId: "studio",
    publicAssets: ["ui.mjs"],
  });
  const module: ControlPluginUiModule = {
    key: JSON.stringify([lease.descriptor.pluginId, lease.contributionId]),
    mountKey: JSON.stringify([lease.packageDigest, lease.selectionRevision]),
    title: "Krea2 installed package fixture",
    contributionId: lease.contributionId,
    plugin: {
      descriptor: lease.descriptor,
      packageDigest: lease.packageDigest,
      selectionRevision: lease.selectionRevision,
      publicAssets: lease.publicAssets,
    },
  };
  const thread: ThreadView = {
    threadId: "thread-1",
    title: "Named task fixture",
    status: "active",
    revision: 1,
    lastMessageSequence: 0,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: MODULE_TASK_NOW,
    updatedAt: MODULE_TASK_NOW,
    archivedAt: null,
    deletedAt: null,
  };
  const requests: Request[] = [],
    messages: MessageView[] = [];
  const tasks = new Map<string, ExtensionTaskView>(),
    runs = new Map<string, RunView>();
  const runStreams = new Map<string, ReturnType<typeof sse>[]>(),
    threadStreams: ReturnType<typeof sse>[] = [];
  const bindings = new Map<string, string>();
  let created = false,
    current = true,
    activeRun: string | null = null;
  let nextActionGate: ReturnType<typeof deferred<void>> | null = null;
  const diagnostics: unknown[] = [];
  const assertCurrent = () => {
    if (!current) throw new Error("named_module_session_changed");
  };
  const callbacks = {
    onThread: vi.fn(),
    onTextDelta: vi.fn(),
    onToolItem: vi.fn(),
    onRunSettled: vi.fn(),
    onStreamError: vi.fn(),
    onThreadStreamError: vi.fn(),
  };
  const fetch = vi.fn(
    async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(String(input));
      const request: Request = {
        path: url.pathname + url.search,
        method: options?.method ?? "GET",
        body: options?.body ? JSON.parse(String(options.body)) : null,
        headers: new Headers(options?.headers),
        signal: options?.signal,
      };
      requests.push(request);
      if (url.pathname.startsWith("/api/v1/plugins/ui/mounts")) {
        if (request.method === "DELETE") return json({ closed: true });
        if (url.pathname.endsWith("/actions")) {
          const action = request.body?.action,
            body = request.body?.input as Record<string, unknown>;
          if (
            !created ||
            body.threadId !== thread.threadId ||
            body.expectedThreadRevision !== thread.revision
          )
            throw new Error("named_fixture_thread_revision_mismatch");
          const source =
            action === "image.query" ? (body.sourceRunId as string) : null;
          if (
            action === "image.query" &&
            (source !== "run-1" || body.operationId !== MODULE_TASK_OPERATION)
          )
            throw new Error("named_fixture_wrong_original_query_source");
          if (action !== "image.generate" && action !== "image.query")
            throw new Error("named_fixture_action_unexpected");
          const runId = `run-${tasks.size + 1}`;
          thread.revision++;
          thread.lastMessageSequence++;
          const message: MessageView = {
            messageId: `message-${messages.length + 1}`,
            threadId: thread.threadId,
            sequence: thread.lastMessageSequence,
            role: "user",
            content:
              action === "image.generate"
                ? String((body.input as { prompt: string }).prompt)
                : "Query original image result",
            proposedPlan: null,
            createdAt: MODULE_TASK_NOW,
          };
          messages.push(message);
          bindings.set(message.messageId, runId);
          runs.set(runId, {
            runId,
            threadId: thread.threadId,
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
            createdAt: MODULE_TASK_NOW,
            updatedAt: MODULE_TASK_NOW,
            terminalAt: null,
          });
          const task: ExtensionTaskView = {
            runId,
            threadId: thread.threadId,
            pluginId: lease.descriptor.pluginId,
            pluginVersion: lease.descriptor.version,
            configurationRevision: 1,
            runStatus: "running",
            sourceRunId: source,
            operations: [
              {
                operationId: MODULE_TASK_OPERATION,
                sourceRunId: source ?? runId,
                status: source ? "succeeded" : "submitted",
                observedAt: MODULE_TASK_NOW,
                images: source
                  ? [
                      {
                        url: "https://images.fixture.invalid/krea.png",
                        filename: "krea.png",
                      },
                    ]
                  : [],
              },
            ],
            truncated: false,
          };
          tasks.set(runId, task);
          activeRun = runId;
          const receipt = {
            disposition: "committed",
            threadId: thread.threadId,
            threadRevision: thread.revision,
            runId,
            messageId: message.messageId,
            configurationRevision: 1,
          };
          const gate = nextActionGate;
          nextActionGate = null;
          if (gate) await gate.promise;
          return json({ output: receipt });
        }
        return json(lease);
      }
      if (url.pathname === "/api/v1/threads" && request.method === "POST") {
        if (created) throw new Error("named_fixture_second_thread_creation");
        created = true;
        return json({ disposition: "committed", thread });
      }
      if (url.pathname === "/api/v1/threads/thread-1")
        return created
          ? json({ thread, eventSequence: thread.revision })
          : error("thread_not_found");
      if (url.pathname === "/api/v1/threads/thread-1/runs")
        return json({ data: [...runs.values()].reverse(), nextCursor: null });
      if (url.pathname === "/api/v1/threads/thread-1/active-run")
        return json({
          schemaVersion: "crewon.thread-active-run.v0",
          threadId: thread.threadId,
          run: activeRun ? runs.get(activeRun) : null,
        });
      if (url.pathname === "/api/v1/threads/thread-1/transcript-window")
        return json({
          schemaVersion: "crewon.transcript-window.v0",
          messageWindow: {
            schemaVersion: "crewon.message-window.v0",
            threadId: thread.threadId,
            threadRevision: thread.revision,
            eventSequence: thread.revision,
            headMessageSequence: thread.lastMessageSequence,
            data: messages,
            olderCursor: null,
            newerCursor: null,
          },
          runBindings: messages.map((message) => ({
            messageId: message.messageId,
            runId: bindings.get(message.messageId),
            source:
              message.role === "user"
                ? "turnStartReceipt"
                : "messageCompletedEvent",
          })),
        });
      const taskMatch =
        /^\/api\/v1\/extensions\/crewon\.comfyui-krea2\/tasks\/([^/]+)$/u.exec(
          url.pathname,
        );
      if (taskMatch)
        return tasks.has(taskMatch[1]!)
          ? json({ task: tasks.get(taskMatch[1]!) })
          : error("extension_task_not_found");
      const runId = /^\/api\/v1\/(?:threads\/thread-1\/)?runs\/([^/]+)/u.exec(
        url.pathname,
      )?.[1];
      if (runId && url.pathname.endsWith("/plan"))
        return json({
          runId,
          eventSequence: runs.get(runId)!.lastSequence,
          plan: null,
        });
      if (url.pathname.endsWith("/events")) {
        const stream = sse(options?.signal);
        if (runId) {
          const streams = runStreams.get(runId) ?? [];
          streams.push(stream);
          runStreams.set(runId, streams);
        } else threadStreams.push(stream);
        return stream.response;
      }
      if (runId)
        return runs.has(runId)
          ? json({ run: runs.get(runId) })
          : error("run_not_found");
      throw new Error(`unexpected_named_module_request:${request.path}`);
    },
  );
  const client = new ControlApiClient({
    baseUrl: location.origin,
    accessToken: "named-module-user-session",
    csrfToken: "named-module-csrf",
    fetch,
  });
  const runtime = new ControlThreadRuntime(
    {
      client,
      reconnectDelay: async () => {},
      runStatusPollDelay: (signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    },
    callbacks,
  );
  const receipts = createInstalledPluginTaskReceipts({
    assertCurrent,
    onDiagnostic: (value) => diagnostics.push(value),
  });
  const importer = vi.fn(async (url: string) => {
    if (!url.endsWith("/assets/ui.mjs"))
      throw new Error("named_fixture_foreign_import");
    // Vitest rewrites ESM exports to accessors. Preserve the real native module namespace ABI here.
    const nativeImport = compileFunction(
      "return import(specifier)",
      ["specifier"],
      {
        importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      },
    ) as (specifier: string) => Promise<unknown>;
    return nativeImport(artifact.entryUrl);
  });
  const host = createControlPluginUiHost({
    client,
    assertCurrent,
    importer,
    onDiagnostic: (value) => diagnostics.push(value),
    onTaskReceipt: receipts.observe,
  });
  const ports: InstalledPluginTaskPorts = {
    client,
    runtime,
    assertSessionCurrent: assertCurrent,
    receiptSource: receipts,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (
    active: boolean,
    selectedThreadId: string | null = null,
  ) =>
    act(async () => {
      root.render(
        <InstalledPluginModule
          host={host}
          module={module}
          active={active}
          theme={{ mode: "light", tokens: {} }}
          locale="zh"
          onDiagnostic={(value) => diagnostics.push(value)}
          taskPorts={ports}
          selectedThreadId={selectedThreadId}
          onOpenTask={vi.fn()}
        />,
      );
      await settleModuleTask();
    });
  return {
    container,
    render,
    client,
    runtime,
    requests,
    receipts,
    tasks,
    thread,
    runs,
    importer,
    diagnostics,
    callbacks,
    runStreams,
    threadStreams,
    actionRequests: () =>
      requests.filter((request) => request.path.endsWith("/actions")),
    gateAction() {
      const gate = deferred<void>();
      nextActionGate = gate;
      return gate;
    },
    revoke() {
      current = false;
      receipts.invalidate();
    },
    event(
      runId: string,
      sequence: number,
      type: RunEventView["type"],
      data: object,
    ) {
      return {
        eventId: `named-${runId}-${sequence}`,
        runId,
        sequence,
        type,
        data,
        occurredAt: MODULE_TASK_NOW,
      } as RunEventView;
    },
    async close() {
      await act(async () => {
        root.unmount();
        await settleModuleTask();
      });
      receipts.invalidate();
      runtime.close();
      for (const streams of runStreams.values())
        streams.forEach((stream) => stream.finish());
      threadStreams.forEach((stream) => stream.finish());
      container.remove();
    },
  };
}

export async function settleModuleTask() {
  // Native ESM import and streaming readers need an event-loop turn, not only microtasks.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let count = 0; count < 180; count++) await Promise.resolve();
}
export async function moduleTaskUntil(check: () => void) {
  let failure: unknown;
  for (let count = 0; count < 100; count++) {
    try {
      check();
      return;
    } catch (error) {
      failure = error;
    }
    await act(settleModuleTask);
  }
  throw failure;
}
export async function clickModuleTask(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (value) => value.textContent === text,
  );
  if (!button || button.disabled)
    throw new Error(`named_module_button_unavailable:${text}`);
  await act(async () => {
    button.click();
    await settleModuleTask();
  });
}
