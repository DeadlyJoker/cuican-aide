import { assertPluginTaskFunding } from "@crewon/domain";
import {
  assertPluginTaskAdmission,
  extensionCanonicalJson,
  parseExtensionRunBinding,
  parsePluginTaskAdmission,
  type ExtensionRunBinding,
  type PluginTaskAdmission,
  type RunState,
  reduceRunLifecycleEvent,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ExtensionStore } from "./extension-store-port.ts";
import type { RunStore } from "./run-store-port.ts";
import type { ExternalOperationStore } from "./external-operation-store-port.ts";
import type {
  ExtensionRegistration,
  ExtensionReadiness,
} from "./extension-host-port.ts";
import type {
  ExtensionConfiguration,
  ExtensionExecutionTarget,
} from "@crewon/domain";
import { assertCommittedRun } from "./plugin-ui-committed-task-support.ts";

export type PluginQuerySource = Readonly<{
  admission: PluginTaskAdmission;
  binding: ExtensionRunBinding;
  operationId: string;
}>;
/** Installed historical readiness only. Source records confer no current permission. */
export interface PluginQueryHostPort {
  resolveRegistration(
    input: Readonly<{ actor: ActorContext; source: PluginQuerySource }>,
  ): Promise<ExtensionRegistration | null>;
  evaluate(
    input: Readonly<{
      actor: ActorContext;
      source: PluginQuerySource;
      registration: ExtensionRegistration;
      configuration: ExtensionConfiguration;
      expectedTarget: ExtensionExecutionTarget;
    }>,
  ): Promise<ExtensionReadiness>;
}
type PluginQuerySourceStorageInput = Readonly<{
  actor: ActorContext;
  pluginId: string;
  profileId: string;
  publisherId: string;
  sourceRunId: string;
  operationId: string;
  extensions: Pick<
    ExtensionStore,
    | "loadPluginTaskAdmission"
    | "loadExtensionRunBinding"
    | "loadExtensionTurnReceipt"
  >;
  runs: Pick<RunStore, "loadRunInSpace">;
  operations: Pick<ExternalOperationStore, "loadExternalOperation">;
  digester: ContentDigester;
}>;
export async function loadPluginQuerySource(
  input: PluginQuerySourceStorageInput &
    Readonly<{ authorization: AuthorizationPort }>,
): Promise<PluginQuerySource> {
  const run = await loadSourceRun(input);
  const allow = await input.authorization.authorize({
    actor: input.actor,
    action: "run:read",
    resource: {
      kind: "run",
      tenantId: input.actor.tenantId,
      spaceId: input.actor.spaceId,
      runId: input.sourceRunId,
      threadId: run.threadId,
    },
  });
  if (allow.outcome !== "allow")
    throw new ApplicationError("authorization", "authorization_denied");
  return verifyPluginQuerySourceStorage(input, run);
}

/** Persistent receipt proof after COMMIT; it establishes no current authorization. */
export async function loadPluginQuerySourceProof(
  input: PluginQuerySourceStorageInput,
): Promise<PluginQuerySource> {
  return verifyPluginQuerySourceStorage(input, await loadSourceRun(input));
}

async function loadSourceRun(
  input: PluginQuerySourceStorageInput,
): Promise<RunState> {
  const locator = {
    tenantId: input.actor.tenantId,
    spaceId: input.actor.spaceId,
    runId: input.sourceRunId,
  };
  const run = await input.runs.loadRunInSpace(locator);
  if (
    run === null ||
    run.tenantId !== locator.tenantId ||
    run.spaceId !== locator.spaceId ||
    run.runId !== locator.runId
  )
    throw new ApplicationError("notFound", "plugin_query_source_not_found");
  return run;
}

async function verifyPluginQuerySourceStorage(
  input: PluginQuerySourceStorageInput,
  run: RunState,
): Promise<PluginQuerySource> {
  const locator = {
    tenantId: input.actor.tenantId,
    spaceId: input.actor.spaceId,
    runId: input.sourceRunId,
  };
  if (typeof input.extensions.loadPluginTaskAdmission !== "function")
    throw new ApplicationError("conflict", "plugin_query_source_unavailable");
  const rawAdmission = await input.extensions.loadPluginTaskAdmission(locator);
  const rawBinding = await input.extensions.loadExtensionRunBinding(locator);
  if (rawAdmission === null || rawBinding === null)
    throw new ApplicationError("notFound", "plugin_query_source_not_found");
  const admission = parsePluginTaskAdmission(rawAdmission);
  const binding = parseExtensionRunBinding(rawBinding, input.digester);
  const receipt = {
    actorId: admission.actorId,
    idempotencyKey: admission.idempotencyKey,
    requestDigest: admission.requestDigest,
  };
  assertPluginTaskAdmission({ admission, binding, receipt }, input.digester);
  if (
    admission.tenantId !== locator.tenantId ||
    admission.spaceId !== locator.spaceId ||
    admission.profileId !== input.profileId ||
    admission.publisherId !== input.publisherId ||
    admission.pluginId !== input.pluginId ||
    binding.runId !== locator.runId ||
    binding.threadId !== run.threadId ||
    binding.actorId !== run.createdByActorId ||
    [
      "agentVersionId",
      "authorityId",
      "runtimeGeneration",
      "policySnapshotId",
      "workspaceBindingId",
    ].some(
      (key) =>
        binding.target[key as keyof typeof binding.target] !==
        run[key as keyof typeof run],
    )
  )
    throw new ApplicationError(
      "conflict",
      "plugin_query_source_identity_mismatch",
    );
  const saved = await input.extensions.loadExtensionTurnReceipt({
    ...binding,
    receipt,
  });
  if (
    saved === null ||
    saved.schemaVersion !== "crewon.extension-turn-admission.v0" ||
    extensionCanonicalJson(saved.binding) !== extensionCanonicalJson(binding)
  )
    throw new ApplicationError(
      "conflict",
      "plugin_query_source_receipt_invalid",
    );
  if (
    saved.run.events.length !== 1 ||
    saved.run.events[0]?.type !== "run.created"
  )
    throw new ApplicationError(
      "conflict",
      "plugin_query_source_receipt_invalid",
    );
  const original = reduceRunLifecycleEvent(null, saved.run.events[0]);
  assertCommittedRun(original, binding);
  assertCommittedRun(run, binding);
  if (
    extensionCanonicalJson(original) !==
      extensionCanonicalJson(saved.run.state) ||
    extensionCanonicalJson(original) !==
      extensionCanonicalJson(saved.turn.runState) ||
    extensionCanonicalJson(saved.run.events) !==
      extensionCanonicalJson(saved.turn.runEvents) ||
    saved.turn.messages.length !== 1 ||
    saved.turn.messages[0]?.tenantId !== binding.tenantId ||
    saved.turn.messages[0]?.threadId !== binding.threadId ||
    saved.turn.messages[0]?.role !== "user" ||
    saved.turn.messages[0]?.contentDigest !== binding.inputDigest ||
    input.digester.sha256(saved.turn.messages[0].content) !==
      binding.inputDigest
  )
    throw new ApplicationError(
      "conflict",
      "plugin_query_source_receipt_invalid",
    );
  assertPluginTaskFunding(
    {
      creditAdmission: saved.creditAdmission,
      unmeteredAdmission: saved.unmeteredAdmission,
      binding,
      receipt,
      principalId: admission.principalId,
      task: admission,
    },
    input.digester,
  );
  const operation = await input.operations.loadExternalOperation({
    tenantId: locator.tenantId,
    runId: binding.runId,
    bindingDigest: binding.bindingDigest,
    operationId: input.operationId,
  });
  if (operation === null)
    throw new ApplicationError("notFound", "plugin_query_source_not_found");
  if (
    operation.tenantId !== locator.tenantId ||
    operation.runId !== binding.runId ||
    operation.bindingDigest !== binding.bindingDigest ||
    operation.operationId !== input.operationId
  )
    throw new ApplicationError(
      "conflict",
      "plugin_query_operation_identity_mismatch",
    );
  return Object.freeze({ admission, binding, operationId: input.operationId });
}
