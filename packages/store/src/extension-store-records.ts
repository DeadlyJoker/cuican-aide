import { createHash } from "node:crypto";
import {
  extensionCanonicalJson,
  extensionDigest,
  extensionOpaqueId,
  extensionRevision,
  parseExtensionActivation,
  parseExtensionConfiguration,
  parseExtensionRunBinding,
  parseExtensionScope,
  type ExtensionActivation,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
  type ExtensionRunBinding,
  type ExtensionScope,
} from "@crewon/domain";
import type {
  CommitExtensionRunInput,
  CommitExtensionRunResult,
  ExtensionMutationReceipt,
  SaveExtensionActivationInput,
  SaveExtensionConfigurationInput,
} from "@crewon/application";

export const extensionStoreDigester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export function extensionScopeValues(
  scope: ExtensionScope,
): [string, string, string] {
  const value = parseExtensionScope(scope);
  return [value.tenantId, value.spaceId, value.pluginId];
}
export function validateExtensionReceipt(receipt: ExtensionMutationReceipt) {
  extensionOpaqueId(receipt.actorId);
  extensionOpaqueId(receipt.idempotencyKey);
  extensionDigest(receipt.requestDigest);
}
export function validateConfigurationSave(
  input: SaveExtensionConfigurationInput,
) {
  const configuration = parseExtensionConfiguration(
    input.configuration,
    extensionStoreDigester,
  );
  extensionRevision(input.expectedRevision, { minimum: 0 });
  validateExtensionReceipt(input.receipt);
  if (
    configuration.revision !== input.expectedRevision + 1 ||
    configuration.createdByActorId !== input.receipt.actorId
  )
    throw new Error("extension_configuration_authority_mismatch");
  return configuration;
}
export function validateActivationSave(input: SaveExtensionActivationInput) {
  const activation = parseExtensionActivation(input.activation);
  extensionRevision(input.expectedRevision, { minimum: 0 });
  validateExtensionReceipt(input.receipt);
  if (
    activation.revision !== input.expectedRevision + 1 ||
    activation.updatedByActorId !== input.receipt.actorId
  )
    throw new Error("extension_activation_authority_mismatch");
  return activation;
}
export function assertExtensionConfigurationReference(
  configuration: ExtensionConfiguration | null,
  value: Pick<
    ExtensionActivation,
    "configurationRevision" | "configurationDigest"
  >,
) {
  if (
    configuration === null ||
    configuration.revision !== value.configurationRevision ||
    configuration.contentDigest !== value.configurationDigest
  )
    throw new Error("extension_configuration_not_found");
}
export function assertExtensionReplay(
  existing: ExtensionConfiguration | ExtensionActivation,
  requested: ExtensionConfiguration | ExtensionActivation,
) {
  function content(value: ExtensionConfiguration | ExtensionActivation) {
    if (value.schemaVersion === "crewon.extension-configuration.v0") {
      const { createdAt: _, contentDigest: __, ...body } = value;
      return extensionCanonicalJson(body);
    }
    const { updatedAt: _, ...body } = value;
    return extensionCanonicalJson(body);
  }
  if (content(existing) !== content(requested))
    throw new Error("extension_idempotency_conflict");
}

export function validateExtensionRunCommit(input: CommitExtensionRunInput) {
  const binding = parseExtensionRunBinding(
    input.binding,
    extensionStoreDigester,
  );
  validateExtensionReceipt(input.receipt);
  extensionRevision(input.expectedActivationRevision);
  const event = input.commit.events[0];
  if (
    input.commit.expectedRevision !== 0 ||
    input.commit.events.length !== 1 ||
    event?.type !== "run.created" ||
    input.commit.tenantId !== binding.tenantId ||
    event.identity.runId !== binding.runId ||
    event.data.tenantId !== binding.tenantId ||
    event.data.spaceId !== binding.spaceId ||
    event.data.threadId !== binding.threadId ||
    event.data.createdByActorId !== binding.actorId ||
    input.receipt.actorId !== binding.actorId ||
    event.data.agentVersionId !== binding.target.agentVersionId ||
    event.data.authorityId !== binding.target.authorityId ||
    event.data.runtimeGeneration !== binding.target.runtimeGeneration ||
    event.data.policySnapshotId !== binding.target.policySnapshotId ||
    event.data.workspaceBindingId !== binding.target.workspaceBindingId
  )
    throw new Error("extension_run_authority_mismatch");
  return binding;
}

export function assertExtensionAdmission(
  binding: ExtensionRunBinding,
  activation: ExtensionActivation | null,
  expectedRevision: number,
  configuration: ExtensionConfiguration | null,
) {
  if (activation === null || activation.state === "revoked")
    throw new Error("extension_access_revoked");
  if (activation.revision !== expectedRevision)
    throw new Error("extension_activation_revision_conflict");
  assertExtensionConfigurationReference(configuration, binding);
  if (
    binding.source === null &&
    (activation.state !== "enabled" ||
      activation.configurationRevision !== binding.configurationRevision ||
      activation.configurationDigest !== binding.configurationDigest ||
      extensionCanonicalJson(activation.target) !==
        extensionCanonicalJson(binding.target))
  )
    throw new Error("extension_generation_disabled");
}

export function assertExtensionQuerySource(
  binding: ExtensionRunBinding,
  source: ExtensionRunBinding | null,
  operationExists: boolean,
) {
  if (binding.source === null) return;
  if (
    source === null ||
    source.source !== null ||
    source.pluginId !== binding.pluginId ||
    source.tenantId !== binding.tenantId ||
    source.spaceId !== binding.spaceId ||
    source.bindingDigest !== binding.source.bindingDigest ||
    source.runId !== binding.source.runId ||
    !operationExists ||
    source.configurationRevision !== binding.configurationRevision ||
    source.configurationDigest !== binding.configurationDigest ||
    extensionCanonicalJson(source.target) !==
      extensionCanonicalJson(binding.target)
  )
    throw new Error("extension_query_source_not_found");
}

/** Checks persisted deployment identity, not runtime readiness or plugin authorization. */
export function assertExtensionDeployment(
  target: ExtensionExecutionTarget,
  asset: { content_digest: string; definition_json: unknown } | undefined,
  deployment: unknown,
) {
  const value = deployment as Record<string, unknown> | null;
  const definition = (
    typeof asset?.definition_json === "string"
      ? JSON.parse(asset.definition_json)
      : asset?.definition_json
  ) as Record<string, unknown> | undefined;
  if (
    asset === undefined ||
    value === null ||
    typeof value !== "object" ||
    definition === undefined ||
    definition === null ||
    typeof definition !== "object" ||
    asset.content_digest !== target.agentVersionContentDigest ||
    value.contentDigest !== target.agentVersionContentDigest ||
    value.agentVersionId !== target.agentVersionId ||
    value.materializationDigest !== target.materializationDigest ||
    value.authorityId !== target.authorityId ||
    value.workspaceBindingId !== target.workspaceBindingId ||
    definition.agentVersionId !== target.agentVersionId ||
    definition.runtimeGeneration !== target.runtimeGeneration ||
    definition.policySnapshotId !== target.policySnapshotId
  )
    throw new Error("extension_execution_target_not_deployed");
}

export function extensionTaskCommit(input: CommitExtensionRunInput) {
  return {
    ...input.commit,
    idempotency: {
      scope: `extension-task:${extensionStoreDigester.sha256(extensionCanonicalJson([...extensionScopeValues(input.binding), input.receipt.actorId]))}`,
      key: input.receipt.idempotencyKey,
      requestFingerprint: input.receipt.requestDigest,
    },
  };
}

export function parseExtensionTaskReceipt(
  input: unknown,
  scope: ExtensionScope,
  receipt: ExtensionMutationReceipt,
): CommitExtensionRunResult {
  const value = input as CommitExtensionRunResult;
  const binding = parseExtensionRunBinding(
    value.binding,
    extensionStoreDigester,
  );
  if (
    extensionCanonicalJson(extensionScopeValues(binding)) !==
      extensionCanonicalJson(extensionScopeValues(scope)) ||
    binding.actorId !== receipt.actorId ||
    value.run.state.runId !== binding.runId ||
    value.run.state.threadId !== binding.threadId ||
    value.run.state.tenantId !== binding.tenantId ||
    value.run.state.spaceId !== binding.spaceId
  )
    throw new Error("extension_task_receipt_invalid");
  return { run: { ...value.run, disposition: "replayed" }, binding };
}

export function parseExtensionConfigurationReceipt(
  input: unknown,
  scope: ExtensionScope,
  receipt: ExtensionMutationReceipt,
) {
  const configuration = parseExtensionConfiguration(
    input,
    extensionStoreDigester,
  );
  assertReceiptIdentity(
    configuration,
    configuration.createdByActorId,
    scope,
    receipt,
  );
  return configuration;
}

export function parseExtensionActivationReceipt(
  input: unknown,
  scope: ExtensionScope,
  receipt: ExtensionMutationReceipt,
) {
  const activation = parseExtensionActivation(input);
  assertReceiptIdentity(
    activation,
    activation.updatedByActorId,
    scope,
    receipt,
  );
  return activation;
}

function assertReceiptIdentity(
  value: ExtensionScope,
  actorId: string,
  scope: ExtensionScope,
  receipt: ExtensionMutationReceipt,
) {
  if (
    actorId !== receipt.actorId ||
    extensionCanonicalJson(extensionScopeValues(value)) !==
      extensionCanonicalJson(extensionScopeValues(scope))
  )
    throw new Error("extension_mutation_receipt_invalid");
}
