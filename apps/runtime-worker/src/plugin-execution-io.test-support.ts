import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import type {
  ExternalOperation,
  ExternalOperationStore,
  WorkItemClaim,
} from "@crewon/application";
import {
  dispatchToolExecutionReceipt,
  prepareToolExecutionReceipt,
} from "@crewon/domain";
import { SqliteExternalOperationStore } from "@crewon/store";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type {
  ToolExecutionCommand,
  ToolExecutionResolution,
} from "@crewon/tool-broker";
import {
  command,
  context,
  deferred,
  policy,
} from "./plugin-tool-runtime-adapter.test-support.ts";
import {
  PluginExecutionIoOwner,
  type PluginExecutionIoDependencies,
} from "./plugins/plugin-execution-io.ts";
import {
  withCheckedWorkerToolDispatch,
  withWorkerToolDispatch,
} from "./plugins/worker-tool-dispatch-authority.ts";
export { command, deferred, policy };

export const submission = {
  method: "POST" as const,
  path: "/prompt",
  body: { prompt: "fixture workflow" },
};
export const response = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from('{"prompt_id":"provider-1"}'),
};

export async function ioFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-plugin-io-unit-"));
  const path = join(directory, "operations.sqlite");
  let database = new DatabaseSync(path);
  let store = new SqliteExternalOperationStore(database);
  await store.migrate();
  const supplied = context();
  const runtimeContext: PluginToolRuntimeContext = {
    ...supplied,
    configuration: {
      ...supplied.configuration,
      parameters: { baseUrl: "https://comfy.example/" },
    },
  };
  const original = command({}, policy("mutation", "reconcilable"));
  const operationId = operationIdentity(runtimeContext, original);
  const locator = {
    tenantId: runtimeContext.scope.tenantId,
    runId: runtimeContext.run.runId,
    bindingDigest: runtimeContext.run.bindingDigest,
    operationId,
  };
  const owners: PluginExecutionIoOwner[] = [];
  const cleanup: (() => void)[] = [];
  const controls = {
    authorized: true,
    claim: null as WorkItemClaim | null,
    dns: 0,
    sends: 0,
    loads: 0,
    reserves: 0,
    advances: 0,
    echo: null as Partial<ExternalOperation> | null,
    beforeAdvance: null as (() => Promise<void>) | null,
    purposes: [] as ("submit" | "observe")[],
  };
  const operations: ExternalOperationStore = {
    reserveExternalOperation: async (input) => {
      controls.reserves++;
      return store.reserveExternalOperation(input);
    },
    loadExternalOperation: async (input) => {
      controls.loads++;
      const saved = await store.loadExternalOperation(input);
      return saved !== null && controls.echo !== null
        ? { ...saved, ...controls.echo }
        : saved;
    },
    advanceExternalOperation: async (input) => {
      controls.advances++;
      await controls.beforeAdvance?.();
      return store.advanceExternalOperation(input);
    },
  };
  const owner = (overrides: Partial<PluginExecutionIoDependencies> = {}) => {
    const value = new PluginExecutionIoOwner({
      context: runtimeContext,
      operations,
      approvalRequirement: "none",
      network: {
        baseUrlParameter: "baseUrl",
        paths: [
          { method: "POST", path: "/prompt" },
          { method: "GET", path: "/queue" },
          { method: "GET", operationPathPrefix: "/history/" },
        ],
      },
      dns: {
        resolveAll: async () => {
          controls.dns++;
          return [{ address: "8.8.8.8", family: 4 }];
        },
      },
      transport: {
        request: async () => {
          controls.sends++;
          return response;
        },
      },
      authorize: async ({ purpose }) => {
        controls.purposes.push(purpose);
        if (!controls.authorized)
          throw new Error("fixture_current_authority_revoked");
      },
      now: () => new Date("2026-10-03T00:00:00.000Z"),
      ...overrides,
    });
    owners.push(value);
    return value;
  };
  /** Private issuer unit fixture, not a real RuntimeWorker dispatch or authorization provider. */
  const invoke = async (
    value: PluginExecutionIoOwner,
    delegate: (checked: ToolExecutionCommand) => Promise<void>,
    options: {
      command?: ToolExecutionCommand;
      method?: "execute" | "reconcile" | "cancel";
      controller?: AbortController;
    } = {},
  ) => {
    const originalCommand = options.command ?? original;
    const signal = (options.controller ?? new AbortController()).signal;
    const receipt = dispatchToolExecutionReceipt(
      prepareToolExecutionReceipt({
        receiptId: "fixture-tool-receipt",
        tenantId: "tenant-1",
        runId: originalCommand.runId,
        stepId: originalCommand.executionLease.stepId,
        attemptId: originalCommand.executionLease.attemptId,
        workItemId: originalCommand.executionLease.workItemId,
        executionId: originalCommand.executionId,
        idempotencyKey: originalCommand.idempotencyKey,
        actionDigest: originalCommand.actionDigest,
        actionIntent: originalCommand.actionIntent,
        call: {
          segmentId: originalCommand.segmentId,
          callId: originalCommand.callId,
          kind: originalCommand.kind,
          name: originalCommand.name,
          inputDigest: originalCommand.actionIntent.tool.inputDigest,
        },
        effect: originalCommand.actionIntent.effect,
        recovery: originalCommand.actionIntent.recovery,
        preparedAt: "2026-10-03T00:00:00.000Z",
      }),
      "2026-10-03T00:00:01.000Z",
    );
    controls.claim = {
      workItem: {
        workItemId: originalCommand.executionLease.workItemId,
        tenantId: "tenant-1",
        runId: originalCommand.runId,
        kind: "run.execute",
        payload: {},
        createdAt: receipt.preparedAt,
      },
      lease: {
        ownerId: "unit-issuer",
        leaseId: originalCommand.executionLease.leaseId,
        epoch: originalCommand.executionLease.leaseEpoch,
        expiresAt: originalCommand.executionLease.expiresAt,
      },
    };
    const checked = structuredClone(originalCommand);
    const invocation = {
      command: checked,
      method: options.method ?? "execute",
      signal,
    };
    return withWorkerToolDispatch(
      {
        ...invocation,
        command: originalCommand,
        receipt,
        assertCurrent: () => controls.claim!,
      },
      () =>
        withCheckedWorkerToolDispatch({ ...invocation, originalCommand }, () =>
          value.withInvocation(invocation, async () => {
            await delegate(checked);
            return completion(checked);
          }),
        ),
    );
  };
  t.after(async () => {
    for (const release of cleanup) release();
    await Promise.all(owners.map((value) => value.close()));
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    context: runtimeContext,
    original,
    operationId,
    locator,
    controls,
    operations,
    owner,
    invoke,
    releaseOnCleanup: (release: () => void) => {
      cleanup.push(release);
    },
    stored: () => store.loadExternalOperation(locator),
    reopen: async () => {
      database.close();
      database = new DatabaseSync(path);
      store = new SqliteExternalOperationStore(database);
      await store.migrate();
    },
  };
}

function completion(value: ToolExecutionCommand): ToolExecutionResolution {
  return {
    status: "completed",
    executionId: value.executionId,
    providerReceiptId: "unit-fixture",
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: value.callId,
      output: "ok",
      isError: false,
      artifactRef: null,
    },
  };
}
export function operationIdentity(
  value: PluginToolRuntimeContext,
  invocation: ToolExecutionCommand,
): string {
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        value.scope.tenantId,
        value.run.runId,
        value.run.bindingDigest,
        invocation.idempotencyKey,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
