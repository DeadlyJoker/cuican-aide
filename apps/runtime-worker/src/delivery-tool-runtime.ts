import type {
  ActorContext,
  DeliveryApplicationService,
  DeliveryAccessPort,
  RunLocator,
  ThreadSpaceLocator,
} from "@crewon/application";
import { ApplicationError } from "@crewon/application";
import {
  DeliveryError,
  deliveryId,
  deliveryObject,
  parseDeliveryAssembleRequest,
  parseDeliveryPatchRequest,
  type DeliveryCatalog,
  type DeliveryVersionRecord,
  type RunState,
  type SpreadsheetPage,
  type ThreadState,
} from "@crewon/domain";
import {
  InMemoryToolBroker,
  validateToolExecutionCommand,
  type ToolExecutionCommand,
  type ToolExecutionPolicy,
  type ToolHandler,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import {
  DELIVERY_MODEL_OUTPUT_BYTES,
  deliveryToolDefinitions,
} from "./delivery-tool-catalog.ts";

export interface DeliveryRuntimeAuthorityStore {
  loadRun(locator: RunLocator): Promise<RunState | null>;
  loadThreadInSpace(locator: ThreadSpaceLocator): Promise<ThreadState | null>;
}
type DeliveryToolApplication = Pick<
  DeliveryApplicationService,
  "catalog" | "page" | "assemble" | "patch"
>;

/** Authorization comes from the durable Run and Thread, never Tool input or a host path. */
export class StoreBackedDeliveryAccess implements DeliveryAccessPort {
  readonly #store: DeliveryRuntimeAuthorityStore;
  readonly #tenantId: string;

  constructor(store: DeliveryRuntimeAuthorityStore, tenantId: string) {
    this.#store = store;
    this.#tenantId = tenantId;
  }

  async check(
    actor: ActorContext,
    threadId: string,
    _access: "read" | "write",
  ): Promise<void> {
    if (
      actor.tenantId !== this.#tenantId ||
      actor.actorId !== actor.principalId
    )
      throw new DeliveryError("delivery_access_denied");
    const thread = await this.#store.loadThreadInSpace({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId,
    });
    if (
      thread === null ||
      thread.tenantId !== actor.tenantId ||
      thread.spaceId !== actor.spaceId ||
      thread.threadId !== threadId ||
      thread.createdByActorId !== actor.actorId ||
      thread.status === "deleted" ||
      thread.deletedAt !== null
    ) {
      throw new DeliveryError("delivery_access_denied");
    }
  }

  async checkRun(
    actor: ActorContext,
    threadId: string,
    runId: string,
  ): Promise<void> {
    const resolved = await this.resolve(runId);
    if (
      resolved.threadId !== threadId ||
      resolved.actor.tenantId !== actor.tenantId ||
      resolved.actor.spaceId !== actor.spaceId ||
      resolved.actor.actorId !== actor.actorId ||
      resolved.actor.principalId !== actor.principalId
    ) {
      throw new DeliveryError("delivery_run_access_denied");
    }
  }

  async resolve(runId: string) {
    const run = await this.#store.loadRun({ tenantId: this.#tenantId, runId });
    if (
      run === null ||
      run.tenantId !== this.#tenantId ||
      run.runId !== runId ||
      (run.status !== "running" && run.status !== "reconciling")
    )
      throw new DeliveryError("delivery_run_access_denied");
    const actor = {
      tenantId: run.tenantId,
      spaceId: run.spaceId,
      actorId: run.createdByActorId,
      principalId: run.createdByActorId,
    };
    await this.check(actor, run.threadId, "read");
    return { actor, threadId: run.threadId, run };
  }
}

export function createDeliveryToolRuntime(config: {
  application: DeliveryToolApplication;
  access: StoreBackedDeliveryAccess;
}): ToolRuntimePort {
  const definitions = deliveryToolDefinitions();
  const policies = new Map<string, ToolExecutionPolicy>();
  const handlers = new Map<string, ToolHandler>();
  for (const definition of definitions) {
    const mutation =
      definition.name === "delivery_assemble" ||
      definition.name === "delivery_patch";
    const key = `function:${definition.name}`;
    policies.set(key, {
      effect: mutation ? "mutation" : "readOnly",
      recovery: mutation ? "reconcilable" : "replaySafe",
      resourceBindingId: "thread-deliveries",
      credentialBindingId: null,
      executionTarget: { kind: "control", bindingId: "thread-deliveries" },
      capability: mutation ? "delivery.write.v1" : "delivery.read.v1",
      approvalRequirement: mutation ? "perAction" : "none",
      limits: {
        timeoutMs: 120_000,
        maxOutputBytes: DELIVERY_MODEL_OUTPUT_BYTES,
        maxArtifactBytes: 1,
      },
    });
    handlers.set(key, async (invocation, signal) => {
      try {
        signal.throwIfAborted();
        const { actor, threadId } = await config.access.resolve(
          invocation.runId,
        );
        const input: unknown = JSON.parse(invocation.input);
        const operation = {
          key: invocation.idempotencyKey,
          sourceRunId: invocation.runId,
        };
        switch (invocation.name) {
          case "delivery_catalog": {
            const query = catalogQuery(input);
            const catalog = await config.application.catalog(actor, threadId);
            return { output: catalogPage(catalog, query) };
          }
          case "delivery_read": {
            const page = await config.application.page(
              actor,
              threadId,
              readQuery(input),
            );
            return { output: modelPage(page) };
          }
          case "delivery_assemble":
            return {
              output: versionResult(
                await config.application.assemble(
                  actor,
                  threadId,
                  parseDeliveryAssembleRequest(input),
                  operation,
                ),
              ),
            };
          case "delivery_patch":
            return {
              output: versionResult(
                await config.application.patch(
                  actor,
                  threadId,
                  parseDeliveryPatchRequest(input),
                  operation,
                ),
              ),
            };
          default:
            throw new DeliveryError("delivery_tool_unknown");
        }
      } catch (error) {
        signal.throwIfAborted();
        return {
          isError: true,
          output: JSON.stringify({
            error:
              error instanceof DeliveryError ||
              error instanceof ApplicationError
                ? error.code
                : "delivery_operation_failed",
          }),
        };
      }
    });
  }
  const broker = new InMemoryToolBroker(definitions, handlers, policies);
  const validateAuthority = async (
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ) => {
    validateToolExecutionCommand(command);
    signal.throwIfAborted();
    const { run } = await config.access.resolve(command.runId);
    if (
      run.policySnapshotId !== command.actionIntent.policySnapshotId ||
      run.workspaceBindingId !== command.actionIntent.workspaceBindingId
    ) {
      throw new DeliveryError("delivery_run_intent_mismatch");
    }
    signal.throwIfAborted();
  };
  return {
    definitions: () => broker.definitions(),
    executionPolicy: (kind, name) => broker.executionPolicy(kind, name),
    // The broker validates approval/policy and reserves retained result capacity before dispatch.
    reserveExecution: (command, signal) => {
      const reservation = broker.reserveExecution(command, signal);
      return {
        execute: async () => {
          try {
            await validateAuthority(command, signal);
          } catch (error) {
            reservation.release();
            throw error;
          }
          return reservation.execute();
        },
        release: () => reservation.release(),
      };
    },
    execute: async (command, signal) => {
      await validateAuthority(command, signal);
      return broker.execute(command, signal);
    },
    // A committed mutation is found by the application's durable idempotency key. A crash before
    // its transaction committed can safely re-enter that same transaction, including CAS checks.
    reconcile: async (command, signal) => {
      await validateAuthority(command, signal);
      return broker.execute(command, signal);
    },
    cancel: (command, signal) => broker.cancel(command, signal),
    retainedExecutionResults: (query) => broker.retainedExecutionResults(query),
    readRetainedExecutionResult: (lookup) =>
      broker.readRetainedExecutionResult(lookup),
    acknowledgeExecutionResult: (acknowledgement) =>
      broker.acknowledgeExecutionResult(acknowledgement),
  };
}

function readQuery(value: unknown): {
  kind: "input" | "version";
  id: string;
  sheet: string;
  startRow: number;
  limit: number;
} {
  const v = deliveryObject(value, ["kind", "id", "sheet", "startRow", "limit"]);
  if (v.kind !== "input" && v.kind !== "version")
    throw new DeliveryError("delivery_read_kind_invalid");
  if (
    typeof v.sheet !== "string" ||
    v.sheet.length === 0 ||
    v.sheet.length > 255
  )
    throw new DeliveryError("delivery_sheet_invalid");
  return {
    kind: v.kind,
    id: deliveryId(v.id),
    sheet: v.sheet,
    startRow: integer(v.startRow, 1, 100_000),
    limit: integer(v.limit, 1, 100),
  };
}
function catalogQuery(value: unknown) {
  const v = deliveryObject(value, ["kind", "offset", "limit"]);
  if (v.kind !== "inputs" && v.kind !== "deliveries")
    throw new DeliveryError("delivery_catalog_kind_invalid");
  return {
    kind: v.kind,
    offset: integer(v.offset, 0, Number.MAX_SAFE_INTEGER),
    limit: integer(v.limit, 1, 100),
  };
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new DeliveryError("delivery_pagination_invalid");
  return value;
}
function versionResult(record: DeliveryVersionRecord): string {
  return bounded({
    reference: {
      schemaVersion: record.schemaVersion,
      target: record.target,
      deliveryId: record.deliveryId,
      versionId: record.versionId,
      contentDigest: record.contentDigest,
      mediaType: record.mediaType,
      sourceRunId: record.sourceRunId,
      availability: record.availability,
    },
    name: record.name,
    byteLength: record.byteLength,
    parentVersionId: record.parentVersionId,
    validation: {
      status: record.validation.status,
      writtenRows: record.validation.writtenRows,
      formulaCount: record.validation.formulaCount,
    },
  });
}
function catalogPage(
  catalog: DeliveryCatalog,
  query: ReturnType<typeof catalogQuery>,
): string {
  // One entry per sheet keeps even workbooks with many sheets pageable without omitting a sheet.
  const entries =
    query.kind === "inputs"
      ? catalog.inputs.flatMap((record) =>
          record.inspection.sheets.map((sheet) => ({
            inputId: record.inputId,
            name: record.name,
            role: record.role,
            mediaType: record.mediaType,
            byteLength: record.byteLength,
            contentDigest: record.contentDigest,
            sourceRunId: record.sourceRunId ?? null,
            sheet,
          })),
        )
      : catalog.deliveries.flatMap((record) =>
          record.inspection.sheets.map((sheet) => ({
            deliveryId: record.deliveryId,
            versionId: record.versionId,
            name: record.name,
            contentDigest: record.contentDigest,
            byteLength: record.byteLength,
            sourceRunId: record.sourceRunId,
            sheet,
          })),
        );
  const selected = entries.slice(query.offset, query.offset + query.limit);
  const result = () => ({
    target: catalog.target,
    kind: query.kind,
    offset: query.offset,
    totalEntries: entries.length,
    entries: selected,
    nextOffset:
      query.offset + selected.length < entries.length
        ? query.offset + selected.length
        : null,
  });
  while (selected.length > 0 && bytes(result()) > DELIVERY_MODEL_OUTPUT_BYTES)
    selected.pop();
  if (query.offset < entries.length && selected.length === 0)
    throw new DeliveryError("delivery_model_entry_too_large");
  return bounded(result());
}
function modelPage(page: SpreadsheetPage): string {
  const rows = [...page.rows];
  const result = () => ({
    ...page,
    rows,
    nextRow:
      rows.length < page.rows.length
        ? page.startRow + rows.length
        : page.nextRow,
  });
  while (rows.length > 0 && bytes(result()) > DELIVERY_MODEL_OUTPUT_BYTES)
    rows.pop();
  if (rows.length === 0 && page.rows.length > 0)
    throw new DeliveryError("delivery_model_row_too_large");
  return bounded(result());
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function bounded(value: unknown): string {
  if (bytes(value) > DELIVERY_MODEL_OUTPUT_BYTES)
    throw new DeliveryError("delivery_model_output_too_large");
  return JSON.stringify(value);
}
