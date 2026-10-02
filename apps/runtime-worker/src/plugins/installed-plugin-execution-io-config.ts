import { createHash } from "node:crypto";
import type { ExternalOperationStore } from "@crewon/application";
import { parseExternalOperation } from "@crewon/store";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import type { NetworkDnsResolver } from "../network-egress.ts";
import type { PinnedHttpPort } from "../pinned-node-http.ts";
import {
  ioFailure,
  ioJson,
  type PluginExecutionNetworkApproval,
} from "./plugin-execution-io-network.ts";

/** Deployment-owned network grants, evaluated against the immutable admitted Run. */
export type InstalledPluginExecutionIoConfig = Readonly<{
  resolveNetwork(
    context: PluginToolRuntimeContext,
    signal: AbortSignal,
  ): Promise<PluginExecutionNetworkApproval | null>;
  dns?: NetworkDnsResolver;
  transport?: PinnedHttpPort;
  now?: () => Date;
}>;
export type InstalledPluginExecutionIoDependencies =
  InstalledPluginExecutionIoConfig &
    Readonly<{ operations: ExternalOperationStore }>;

export function captureInstalledPluginExecutionIoConfig(
  input: InstalledPluginExecutionIoConfig,
): InstalledPluginExecutionIoConfig {
  if (
    typeof input?.resolveNetwork !== "function" ||
    (input.dns !== undefined && typeof input.dns.resolveAll !== "function") ||
    (input.transport !== undefined &&
      typeof input.transport.request !== "function") ||
    (input.now !== undefined && typeof input.now !== "function")
  )
    ioFailure("configuration_invalid");
  return Object.freeze({
    resolveNetwork: input.resolveNetwork.bind(input),
    ...(input.dns === undefined
      ? {}
      : {
          dns: Object.freeze({
            resolveAll: input.dns.resolveAll.bind(input.dns),
          }),
        }),
    ...(input.transport === undefined
      ? {}
      : {
          transport: Object.freeze({
            request: input.transport.request.bind(input.transport),
          }),
        }),
    ...(input.now === undefined ? {} : { now: input.now.bind(input) }),
  });
}

export function installedPluginExternalOperationId(
  context: PluginToolRuntimeContext,
  command: ToolExecutionCommand,
): string {
  const raw = createHash("sha256")
    .update(
      JSON.stringify([
        context.scope.tenantId,
        context.run.runId,
        context.run.bindingDigest,
        command.idempotencyKey,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

/** Only actual persisted evidence can classify a dispatched replay as observation. */
export async function installedPluginHasExternalOperation(
  input: Readonly<{
    context: PluginToolRuntimeContext;
    command: ToolExecutionCommand;
    operations: ExternalOperationStore;
    signal: AbortSignal;
  }>,
): Promise<boolean> {
  const { context, command, operations, signal } = input;
  signal.throwIfAborted();
  const locator = {
    tenantId: context.scope.tenantId,
    runId: context.run.runId,
    bindingDigest: context.run.bindingDigest,
    operationId: installedPluginExternalOperationId(context, command),
  };
  const saved = await operations.loadExternalOperation(locator);
  signal.throwIfAborted();
  if (saved === null) return false;
  const record = parseExternalOperation(ioJson(saved, 32_768));
  if (
    record.tenantId !== locator.tenantId ||
    record.runId !== locator.runId ||
    record.bindingDigest !== locator.bindingDigest ||
    record.operationId !== locator.operationId ||
    record.executionId !== command.executionId ||
    record.idempotencyKey !== command.idempotencyKey ||
    record.actionDigest !== command.actionDigest
  )
    ioFailure("operation_identity_conflict");
  return true;
}
