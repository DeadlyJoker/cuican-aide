import { createInterface } from "node:readline";

import {
  ApplicationError,
  ModelProviderSettingsApplicationService,
  type ActorContext,
  type ModelProviderSetting,
  type ModelProviderSettingsStore,
} from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";

import {
  NodeSha256ContentDigester,
  StandaloneAuthorization,
} from "./standalone-adapters.ts";

const MAX_COMMAND_BYTES = 64 * 1024;
const TENANT_ID = "standalone-tenant";

type NativeProviderCoordinatorCommand =
  | Readonly<{ phase: "inspect" }>
  | Readonly<{
      phase: "prepare";
      operationId: string;
      runtimeBindingId: string | null;
      expectedRevision: number;
      activeProviderId: string | null;
      bindings: readonly ModelProviderSetting[];
      ttlMs: number;
    }>
  | Readonly<{
      phase: "finalize";
      operationId: string;
      runtimeBindingId: string;
    }>
  | Readonly<{
      phase: "abort";
      operationId: string;
      runtimeBindingId: string;
    }>
  | Readonly<{
      phase: "expire";
      operationId: string;
      recoveryBinding: string;
    }>
  | Readonly<{
      phase: "recover";
      operationId: string;
      runtimeBindingId: string;
      recoveryBinding: string;
    }>;

export type NativeProviderCoordinatorResult = Readonly<{
  phase: NativeProviderCoordinatorCommand["phase"];
  disposition: string | null;
  catalog: Readonly<{
    revision: number;
    activeProviderId: string | null;
    runtimeBindingId: string | null;
  }> | null;
  pending: Readonly<{
    operationId: string;
    baseRevision: number;
    runtimeBindingId: string | null;
    expiresAt: string;
  }> | null;
}>;

export async function runNativeProviderCoordinator(
  input: unknown,
  dependencies: { store: ModelProviderSettingsStore },
): Promise<NativeProviderCoordinatorResult> {
  const command = parseCommand(input);
  if (command.phase === "inspect") {
    return projectState(
      command.phase,
      null,
      await dependencies.store.loadModelProviderSettingsState({
        tenantId: TENANT_ID,
      }),
    );
  }
  const actor = standaloneActor();
  const service = new ModelProviderSettingsApplicationService({
    store: dependencies.store,
    authorization: new StandaloneAuthorization(actor),
    digester: new NodeSha256ContentDigester(),
  });
  if (command.phase === "prepare") {
    const runtimeBindingId = command.runtimeBindingId;
    if ((command.activeProviderId === null) !== (runtimeBindingId === null)) {
      throw new Error("provider_native_command_invalid");
    }
    const result = await service.prepare(
      actor,
      {
        expectedRevision: command.expectedRevision,
        activeProviderId: command.activeProviderId,
        bindings: command.bindings,
      },
      {
        operationId: command.operationId,
        coordinatorBinding:
          runtimeBindingId ?? `${command.operationId}:disabled`,
        ttlMs: command.ttlMs,
      },
      `${command.operationId}:prepare`,
    );
    return projectState(command.phase, result.disposition, {
      catalog: null,
      pending: result.pending,
    });
  }
  if (command.phase === "finalize") {
    const result = await service.finalize(
      actor,
      {
        operationId: command.operationId,
        coordinatorBinding: command.runtimeBindingId,
      },
      `${command.operationId}:finalize`,
    );
    return projectState(command.phase, result.disposition, {
      catalog: result.catalog,
      pending: null,
    });
  }
  if (command.phase === "abort") {
    const result = await service.abort(
      actor,
      {
        operationId: command.operationId,
        coordinatorBinding: command.runtimeBindingId,
      },
      `${command.operationId}:abort`,
    );
    return projectState(command.phase, result.disposition, {
      catalog: result.catalog,
      pending: null,
    });
  }
  if (command.phase === "recover") {
    return recoverOperation(service, actor, command, dependencies.store);
  }
  const result = await service.expire(
    actor,
    {
      operationId: command.operationId,
      recoveryBinding: command.recoveryBinding,
    },
    `${command.operationId}:expire`,
  );
  return projectState(command.phase, result.disposition, {
    catalog: result.catalog,
    pending: null,
  });
}

async function recoverOperation(
  service: ModelProviderSettingsApplicationService,
  actor: ActorContext,
  command: Extract<NativeProviderCoordinatorCommand, { phase: "recover" }>,
  store: ModelProviderSettingsStore,
): Promise<NativeProviderCoordinatorResult> {
  const state = await store.loadModelProviderSettingsState({
    tenantId: TENANT_ID,
  });
  if (state.pending?.operationId === command.operationId) {
    try {
      const result = await service.expire(
        actor,
        {
          operationId: command.operationId,
          recoveryBinding: command.recoveryBinding,
        },
        `${command.operationId}:expire`,
      );
      return projectState(command.phase, "expired", {
        catalog: result.catalog,
        pending: null,
      });
    } catch (error) {
      if (
        !applicationCode(error, "model_provider_settings_operation_not_expired")
      ) {
        throw error;
      }
      const result = await service.abort(
        actor,
        {
          operationId: command.operationId,
          coordinatorBinding: command.runtimeBindingId,
        },
        `${command.operationId}:abort`,
      );
      return projectState(command.phase, "aborted", {
        catalog: result.catalog,
        pending: null,
      });
    }
  }

  try {
    const finalized = await service.finalize(
      actor,
      {
        operationId: command.operationId,
        coordinatorBinding: command.runtimeBindingId,
      },
      `${command.operationId}:finalize`,
    );
    return projectState(command.phase, "finalized", {
      catalog: finalized.catalog,
      pending: null,
    });
  } catch (error) {
    if (!applicationCode(error, "model_provider_settings_operation_mismatch")) {
      throw error;
    }
  }
  try {
    const aborted = await service.abort(
      actor,
      {
        operationId: command.operationId,
        coordinatorBinding: command.runtimeBindingId,
      },
      `${command.operationId}:abort`,
    );
    return projectState(command.phase, "aborted", {
      catalog: aborted.catalog,
      pending: null,
    });
  } catch (error) {
    if (!applicationCode(error, "model_provider_settings_operation_mismatch")) {
      throw error;
    }
  }
  try {
    const expired = await service.expire(
      actor,
      {
        operationId: command.operationId,
        recoveryBinding: command.recoveryBinding,
      },
      `${command.operationId}:expire`,
    );
    return projectState(command.phase, "expired", {
      catalog: expired.catalog,
      pending: null,
    });
  } catch (error) {
    if (!applicationCode(error, "model_provider_settings_operation_mismatch")) {
      throw error;
    }
  }
  return projectState(command.phase, "missing", state);
}

function applicationCode(error: unknown, code: string): boolean {
  return error instanceof ApplicationError && error.code === code;
}

function projectState(
  phase: NativeProviderCoordinatorCommand["phase"],
  disposition: string | null,
  state: Awaited<
    ReturnType<ModelProviderSettingsStore["loadModelProviderSettingsState"]>
  >,
): NativeProviderCoordinatorResult {
  return {
    phase,
    disposition,
    catalog:
      state.catalog === null
        ? null
        : {
            revision: state.catalog.revision,
            activeProviderId: state.catalog.activeProviderId,
            runtimeBindingId: state.catalog.runtimeBindingId,
          },
    pending:
      state.pending === null
        ? null
        : {
            operationId: state.pending.operationId,
            baseRevision: state.pending.baseRevision,
            runtimeBindingId: state.pending.runtimeBindingId,
            expiresAt: state.pending.expiresAt,
          },
  };
}

function parseCommand(value: unknown): NativeProviderCoordinatorCommand {
  if (!object(value) || typeof value.phase !== "string") {
    throw new Error("provider_native_command_invalid");
  }
  if (value.phase === "inspect" && exactKeys(value, ["phase"])) {
    return { phase: "inspect" };
  }
  if (
    value.phase === "prepare" &&
    exactKeys(value, [
      "activeProviderId",
      "bindings",
      "expectedRevision",
      "operationId",
      "phase",
      "runtimeBindingId",
      "ttlMs",
    ])
  ) {
    return value as NativeProviderCoordinatorCommand;
  }
  if (
    (value.phase === "finalize" || value.phase === "abort") &&
    exactKeys(value, ["operationId", "phase", "runtimeBindingId"])
  ) {
    return value as NativeProviderCoordinatorCommand;
  }
  if (
    value.phase === "expire" &&
    exactKeys(value, ["operationId", "phase", "recoveryBinding"])
  ) {
    return value as NativeProviderCoordinatorCommand;
  }
  if (
    value.phase === "recover" &&
    exactKeys(value, [
      "operationId",
      "phase",
      "recoveryBinding",
      "runtimeBindingId",
    ])
  ) {
    return value as NativeProviderCoordinatorCommand;
  }
  throw new Error("provider_native_command_invalid");
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function standaloneActor(): ActorContext {
  return {
    principalId: "standalone-principal",
    actorId: "standalone-actor",
    tenantId: TENANT_ID,
    spaceId: "standalone-space",
  };
}

async function main(): Promise<void> {
  const databasePath = process.env.CREWON_CONTROL_DB_PATH?.trim();
  if (!databasePath) throw new Error("CREWON_CONTROL_DB_PATH_required");
  const input = await readOneCommand();
  const store = new SqliteRunStore(databasePath);
  try {
    const result = await runNativeProviderCoordinator(input, { store });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await store.close();
  }
}

async function readOneCommand(): Promise<unknown> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line) > MAX_COMMAND_BYTES) {
        throw new Error("provider_native_command_invalid");
      }
      lines.close();
      return JSON.parse(line);
    }
  } catch (error) {
    throw new Error("provider_native_command_invalid", { cause: error });
  }
  throw new Error("provider_native_command_invalid");
}

if (process.argv[1]?.endsWith("provider-settings-coordinator.mjs")) {
  await main();
}
