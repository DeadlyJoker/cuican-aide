import { ControlApiClient } from "@crewon/control-client";
import type { GetConceptGenerationResponse } from "@crewon/contracts";
import type {
  PluginUiLease,
  ProjectGenerationUiInput,
  ProjectGenerationUiReceipt,
} from "@crewon/contracts/plugins";
import { vi } from "vitest";
import { createInstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import {
  taskContextError,
  taskContextJson,
  taskContextThread,
} from "./installedPluginTaskContext.test-support";
import { uiLease } from "./pluginUiLoader.test-support";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import type { InstalledPluginGenerationPorts } from "./useInstalledPluginGenerationContext.types";

export function generationContextLease(serial = 1): PluginUiLease {
  const original = uiLease(serial);
  return {
    ...original,
    descriptor: {
      ...original.descriptor,
      requires: [
        {
          service: "crewon.project-generations",
          apiVersion: "1",
          optional: true,
        },
        {
          service: "crewon.project-generation-contexts",
          apiVersion: "1",
          optional: true,
        },
      ],
    },
  };
}
export function generationContextModule(serial = 1): ControlPluginUiModule {
  const lease = generationContextLease(serial);
  return {
    key: JSON.stringify([lease.descriptor.pluginId, lease.contributionId]),
    mountKey: JSON.stringify([
      lease.descriptor.pluginId,
      lease.contributionId,
      serial,
      lease.packageDigest,
    ]),
    title: "Installed generation module",
    contributionId: lease.contributionId,
    plugin: {
      descriptor: lease.descriptor,
      packageDigest: lease.packageDigest,
      selectionRevision: lease.selectionRevision,
      publicAssets: lease.publicAssets,
    },
  };
}
export const generationContextRequest: ProjectGenerationUiInput = Object.freeze(
  {
    reference: Object.freeze({
      projectId: "project-1",
      assetId: "asset-1",
      assetRevision: 2,
      expectedProjectRevision: 7,
      expectedAssetMetadataRevision: 4,
    }),
    threadId: "thread-1",
    expectedThreadRevision: 17,
    idempotencyKey: "saved-generation-user-intent",
  },
);
export const generationContextReceipt: ProjectGenerationUiReceipt =
  Object.freeze({
    disposition: "committed",
    threadId: "thread-1",
    threadRevision: 18,
    runId: "target-paid-run",
    messageId: "target-turn-message",
    configurationRevision: 3,
  });
export function generationContextRecord(): GetConceptGenerationResponse {
  return {
    generation: {
      projectId: "project-1",
      assetId: "asset-1",
      assetRevision: 2,
      briefRevision: 1,
      createdAt: "2026-10-04T00:00:00.000Z",
      task: {
        runId: generationContextReceipt.runId,
        threadId: generationContextReceipt.threadId,
        pluginId: "example.actual-execution",
        pluginVersion: "1.0.0",
        configurationRevision: 3,
        runStatus: "running",
        sourceRunId: null,
        operations: [],
        truncated: false,
      },
    },
  };
}
type Request = {
  path: string;
  method: string;
  body: unknown;
  key: string | null;
  signal: AbortSignal | null | undefined;
};

/** Actual public Control client and journal; deterministic HTTP responses are not a SQL or authority proof. */
export function generationContextFixture() {
  const requests: Request[] = [];
  const threads = new Map([
    ["thread-1", taskContextThread("thread-1", 17)],
    ["thread-2", taskContextThread("thread-2", 41)],
    ["prepared-thread", taskContextThread("prepared-thread", 23)],
  ]);
  let current = true;
  let record = generationContextRecord();
  let handler:
    | ((request: Request) => Response | Promise<Response> | undefined)
    | null = null;
  const assertSessionCurrent = () => {
    if (!current) throw new Error("named_generation_account_withdrawn");
  };
  const client = new ControlApiClient({
    baseUrl: "https://generation-context.fixture.invalid",
    origin: "https://app.fixture.invalid",
    accessToken: "named-test-session",
    csrfToken: "named-test-csrf",
    fetch: async (url, init) => {
      const request = {
        path: new URL(String(url)).pathname,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as unknown) : null,
        key: new Headers(init?.headers).get("idempotency-key"),
        signal: init?.signal,
      };
      requests.push(request);
      const custom = handler?.(request);
      if (custom) return custom;
      if (request.path === "/api/v1/threads" && request.method === "POST")
        return taskContextJson({
          disposition: "committed",
          thread: taskContextThread("prepared-thread", 1),
        });
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
      throw new Error(`unexpected_generation_context_http:${request.path}`);
    },
  });
  const journal = createInstalledPluginGenerationJournal({
    assertCurrent: assertSessionCurrent,
    onDiagnostic: vi.fn(),
  });
  const adopt = vi.fn<
    InstalledPluginGenerationPorts["runtime"]["adoptExtensionTask"]
  >(async () => undefined);
  const open = vi.fn();
  const ports: InstalledPluginGenerationPorts = {
    client,
    runtime: { adoptExtensionTask: adopt },
    journal,
    assertSessionCurrent,
    onOpenTask: open,
  };
  return {
    client,
    journal,
    ports,
    requests,
    threads,
    adopt,
    open,
    setHandler(value: typeof handler) {
      handler = value;
    },
    setRecord(value: GetConceptGenerationResponse) {
      record = value;
    },
    withdraw() {
      current = false;
      journal.invalidate();
    },
    async accept(lease = generationContextLease()) {
      await journal.invoke({
        lease,
        input: generationContextRequest,
        signal: new AbortController().signal,
        request: async () => ({ output: generationContextReceipt }),
      });
    },
    async unknown(lease = generationContextLease()) {
      await journal
        .invoke({
          lease,
          input: generationContextRequest,
          signal: new AbortController().signal,
          request: async () => {
            throw new Error("named_sent_generation_unknown");
          },
        })
        .catch(() => undefined);
    },
  };
}
