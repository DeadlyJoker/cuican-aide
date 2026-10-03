import { ControlApiClient } from "@crewon/control-client";
import type {
  ExtensionTaskView,
  GetConceptGenerationResponse,
} from "@crewon/contracts";
import {
  parsePluginUiLease,
  type ProjectGenerationQueryUiInput,
  type ProjectGenerationQueryUiReceipt,
} from "@crewon/contracts/plugins";
import { vi } from "vitest";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import { createInstalledPluginProjectQueryJournal } from "./installedPluginProjectQueryJournal";
import { createInstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import type { InstalledPluginProjectQueryPorts } from "./useInstalledPluginProjectQueryContext";
import { deferred, uiLease } from "./pluginUiLoader.test-support";
import {
  taskContextError,
  taskContextJson,
  taskContextTask,
  taskContextThread,
} from "./installedPluginTaskContext.test-support";

export function queryJournalLease(pluginId = "example.workbench", serial = 1) {
  const lease = uiLease(serial);
  return parsePluginUiLease({
    ...lease,
    descriptor: {
      ...lease.descriptor,
      pluginId,
      requires: [
        {
          service: "crewon.project-generation-queries",
          apiVersion: "1",
          optional: true,
        },
        {
          service: "crewon.project-generations",
          apiVersion: "1",
          optional: true,
        },
      ],
    },
  });
}
export function queryJournalInput(
  key = "query-original-key",
): ProjectGenerationQueryUiInput {
  return {
    reference: { projectId: "project-1", assetId: "asset-1", assetRevision: 2 },
    operationId: "11111111-1111-4111-8111-111111111111",
    threadId: "thread-1",
    expectedThreadRevision: 17,
    idempotencyKey: key,
  };
}
export function queryJournalReceipt(
  input = queryJournalInput(),
): ProjectGenerationQueryUiReceipt {
  return {
    disposition: "committed",
    threadId: input.threadId,
    threadRevision: input.expectedThreadRevision + 1,
    runId: "target-query-run",
    messageId: "query-turn-message",
    configurationRevision: 3,
  };
}
export function queryJournalFixture() {
  let current = true;
  const assertCurrent = vi.fn(() => {
    if (!current) throw new Error("captured-query-account-changed");
  });
  const onDiagnostic = vi.fn();
  const journal = createInstalledPluginProjectQueryJournal({
    assertCurrent,
    onDiagnostic,
  });
  const lease = queryJournalLease(),
    input = queryJournalInput();
  const gate = deferred<{ output: ProjectGenerationQueryUiReceipt }>();
  let physicalSignal: AbortSignal | undefined;
  const request = vi.fn((signal: AbortSignal) => {
    physicalSignal = signal;
    return gate.promise;
  });
  const caller = new AbortController();
  return {
    journal,
    lease,
    input,
    gate,
    request,
    caller,
    onDiagnostic,
    assertCurrent,
    physicalSignal: () => physicalSignal,
    revoke: () => {
      current = false;
    },
  };
}
export function queryContextModule(
  serial = 1,
  mountSerial = serial,
): ControlPluginUiModule {
  const lease = queryJournalLease("example.business-workbench", serial);
  return {
    key: JSON.stringify([lease.descriptor.pluginId, lease.contributionId]),
    mountKey: JSON.stringify([
      lease.descriptor.pluginId,
      lease.contributionId,
      mountSerial,
      lease.packageDigest,
    ]),
    title: "Installed project query fixture",
    contributionId: lease.contributionId,
    plugin: {
      descriptor: lease.descriptor,
      packageDigest: lease.packageDigest,
      selectionRevision: lease.selectionRevision,
      publicAssets: lease.publicAssets,
    },
  };
}
export function queryContextLease(serial = 1) {
  return queryJournalLease("example.business-workbench", serial);
}
export function queryContextGeneration(): GetConceptGenerationResponse {
  return {
    generation: {
      projectId: "project-1",
      assetId: "asset-1",
      assetRevision: 2,
      briefRevision: 1,
      createdAt: "2026-10-04T00:00:00.000Z",
      task: {
        ...taskContextTask("target-paid-run", {
          pluginId: "example.original-execution",
          pluginVersion: "1.0.0",
          configurationRevision: 3,
          operations: [],
        }),
        sourceRunId: null,
        operations: [],
      },
    },
  };
}
export function queryContextTask(): ExtensionTaskView {
  return taskContextTask("target-query-run", {
    pluginId: "example.original-execution",
    pluginVersion: "1.0.0",
    sourceRunId: "target-paid-run",
    configurationRevision: 3,
    operations: [],
  });
}
export type QueryContextRequest = Readonly<{
  path: string;
  method: string;
  signal: AbortSignal | null | undefined;
}>;

/** Real public Control client parsing and account journals; deterministic HTTP responses are not SQL proof. */
export function queryContextFixture() {
  const requests: QueryContextRequest[] = [];
  const threads = new Map([
    ["thread-1", taskContextThread("thread-1", 17)],
    ["thread-2", taskContextThread("thread-2", 41)],
  ]);
  let current = true,
    record = queryContextGeneration(),
    task = queryContextTask();
  let handler:
    | ((
        request: QueryContextRequest,
      ) => Response | Promise<Response> | undefined)
    | null = null;
  const assertSessionCurrent = vi.fn(() => {
    if (!current) throw new Error("captured-query-account-changed");
  });
  const client = new ControlApiClient({
    baseUrl: "https://project-query-context.fixture.invalid",
    origin: "https://app.fixture.invalid",
    accessToken: "named-query-test-session",
    csrfToken: "named-query-test-csrf",
    fetch: async (url, init) => {
      const request = {
        path: new URL(String(url)).pathname,
        method: init?.method ?? "GET",
        signal: init?.signal,
      };
      requests.push(request);
      const override = handler?.(request);
      if (override) return override;
      const match = /^\/api\/v1\/threads\/([^/]+)$/u.exec(request.path);
      if (match) {
        const thread = threads.get(match[1]);
        return thread
          ? taskContextJson({ thread, eventSequence: thread.revision })
          : taskContextError(404, "thread_not_found");
      }
      if (
        request.path ===
        "/api/v1/creative-projects/project-1/concepts/asset-1/revisions/2/generation"
      )
        return taskContextJson(record);
      if (
        request.path ===
        "/api/v1/extensions/example.original-execution/tasks/target-query-run"
      )
        return taskContextJson({ task });
      throw new Error(
        `unexpected_project_query_http:${request.method}:${request.path}`,
      );
    },
  });
  const journal = createInstalledPluginProjectQueryJournal({
    assertCurrent: assertSessionCurrent,
    onDiagnostic: vi.fn(),
  });
  const generationJournal = createInstalledPluginGenerationJournal({
    assertCurrent: assertSessionCurrent,
    onDiagnostic: vi.fn(),
  });
  const adopt = vi.fn<
      InstalledPluginProjectQueryPorts["runtime"]["adoptExtensionTask"]
    >(async () => undefined),
    open = vi.fn();
  const ports: InstalledPluginProjectQueryPorts = {
    client,
    journal,
    runtime: { adoptExtensionTask: adopt },
    assertSessionCurrent,
    onOpenTask: open,
  };
  return {
    client,
    ports,
    journal,
    generationJournal,
    requests,
    threads,
    adopt,
    open,
    assertSessionCurrent,
    setHandler(value: typeof handler) {
      handler = value;
    },
    setRecord(value: GetConceptGenerationResponse) {
      record = value;
    },
    setTask(value: ExtensionTaskView) {
      task = value;
    },
    withdraw() {
      current = false;
      journal.invalidate();
      generationJournal.invalidate();
    },
    async accept(input = queryJournalInput(), lease = queryContextLease()) {
      await journal.invoke({
        lease,
        input,
        signal: new AbortController().signal,
        request: async () => ({ output: queryJournalReceipt(input) }),
      });
    },
    async unknown(input = queryJournalInput(), lease = queryContextLease()) {
      await journal
        .invoke({
          lease,
          input,
          signal: new AbortController().signal,
          request: async () => {
            throw new Error("named-sent-query-unknown");
          },
        })
        .catch(() => undefined);
    },
  };
}
