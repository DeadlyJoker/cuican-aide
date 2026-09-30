import {
  copyExtensionJson,
  extensionArray,
  extensionFailure,
  extensionIdentifier,
  extensionLocalId,
  extensionRecord,
  extensionText,
  extensionUnique,
} from "./extension-validation.ts";
import type { WorkflowSchemaValue } from "./workflow-schema-value.ts";

export type ExtensionScope = Readonly<{
  tenantId: string;
  spaceId: string;
  pluginId: string;
}>;
export interface ExtensionContentDigester {
  sha256(value: string): string;
}
export type ExtensionConfiguration = ExtensionScope &
  Readonly<{
    schemaVersion: "crewon.extension-configuration.v0";
    revision: number;
    pluginVersion: string;
    manifestDigest: string;
    implementationDigest: string;
    parameters: Readonly<Record<string, WorkflowSchemaValue>>;
    credentialBindings: readonly Readonly<{
      slotId: string;
      credentialBindingId: string;
    }>[];
    createdByActorId: string;
    createdAt: string;
    contentDigest: string;
  }>;

export type ExtensionExecutionTarget = Readonly<{
  executionAuthority: "crewonKernel";
  agentVersionId: string;
  agentVersionContentDigest: string;
  materializationDigest: string;
  authorityId: string;
  runtimeGeneration: string;
  policySnapshotId: string;
  workspaceBindingId: string | null;
}>;

export type ExtensionActivation = ExtensionScope &
  Readonly<{
    schemaVersion: "crewon.extension-activation.v0";
    revision: number;
    configurationRevision: number;
    configurationDigest: string;
    state: "enabled" | "disabled" | "revoked";
    target: ExtensionExecutionTarget | null;
    updatedByActorId: string;
    updatedAt: string;
  }>;

export function parseExtensionScope(input: ExtensionScope): ExtensionScope {
  return {
    tenantId: extensionOpaqueId(input.tenantId),
    spaceId: extensionOpaqueId(input.spaceId),
    pluginId: extensionIdentifier(input.pluginId),
  };
}

export function createExtensionConfiguration(
  input: Omit<ExtensionConfiguration, "contentDigest">,
  digester: ExtensionContentDigester,
): ExtensionConfiguration {
  const normalized = parseConfiguration({
    ...input,
    contentDigest: `sha256:${"0".repeat(64)}`,
  });
  const { contentDigest: _, ...body } = normalized;
  return parseExtensionConfiguration(
    { ...body, contentDigest: digester.sha256(extensionCanonicalJson(body)) },
    digester,
  );
}

export function parseExtensionConfiguration(
  input: unknown,
  digester: ExtensionContentDigester,
): ExtensionConfiguration {
  const value = parseConfiguration(input);
  const { contentDigest, ...body } = value;
  if (digester.sha256(extensionCanonicalJson(body)) !== contentDigest)
    extensionFailure("extension_configuration_digest_mismatch");
  return value;
}

function parseConfiguration(input: unknown): ExtensionConfiguration {
  const value = extensionRecord(copyExtensionJson(input, 32_768), [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "pluginId",
    "revision",
    "pluginVersion",
    "manifestDigest",
    "implementationDigest",
    "parameters",
    "credentialBindings",
    "createdByActorId",
    "createdAt",
    "contentDigest",
  ]);
  if (value.schemaVersion !== "crewon.extension-configuration.v0")
    extensionFailure("extension_configuration_version_unsupported");
  const pluginVersion = extensionText(value.pluginVersion, 32);
  if (
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(pluginVersion)
  )
    extensionFailure("extension_version_invalid");
  const parameters = copyExtensionJson(value.parameters, 16_384);
  if (
    parameters === null ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  )
    extensionFailure("extension_configuration_parameters_invalid");
  const credentialBindings = extensionArray(
    value.credentialBindings,
    0,
    8,
    (entry) => {
      const reference = extensionRecord(entry, [
        "slotId",
        "credentialBindingId",
      ]);
      return Object.freeze({
        slotId: extensionLocalId(reference.slotId),
        credentialBindingId: extensionOpaqueId(reference.credentialBindingId),
      });
    },
  );
  extensionUnique(
    credentialBindings.map((entry) => entry.slotId),
    "extension_credential_slot_duplicate",
  );
  return freeze({
    schemaVersion: value.schemaVersion,
    ...parseExtensionScope(value as unknown as ExtensionScope),
    revision: extensionRevision(value.revision),
    pluginVersion,
    manifestDigest: extensionDigest(value.manifestDigest),
    implementationDigest: extensionDigest(value.implementationDigest),
    parameters: parameters as Record<string, WorkflowSchemaValue>,
    credentialBindings: [...credentialBindings].sort((a, b) =>
      a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0,
    ),
    createdByActorId: extensionOpaqueId(value.createdByActorId),
    createdAt: extensionTimestamp(value.createdAt),
    contentDigest: extensionDigest(value.contentDigest),
  });
}

export function parseExtensionExecutionTarget(
  input: unknown,
): ExtensionExecutionTarget {
  const value = extensionRecord(copyExtensionJson(input, 4_096), [
    "executionAuthority",
    "agentVersionId",
    "agentVersionContentDigest",
    "materializationDigest",
    "authorityId",
    "runtimeGeneration",
    "policySnapshotId",
    "workspaceBindingId",
  ]);
  if (value.executionAuthority !== "crewonKernel")
    extensionFailure("extension_execution_authority_unsupported");
  return Object.freeze({
    executionAuthority: value.executionAuthority,
    agentVersionId: extensionOpaqueId(value.agentVersionId),
    agentVersionContentDigest: extensionDigest(value.agentVersionContentDigest),
    materializationDigest: extensionDigest(value.materializationDigest),
    authorityId: extensionOpaqueId(value.authorityId),
    runtimeGeneration: extensionOpaqueId(value.runtimeGeneration),
    policySnapshotId: extensionOpaqueId(value.policySnapshotId),
    workspaceBindingId:
      value.workspaceBindingId === null
        ? null
        : extensionOpaqueId(value.workspaceBindingId),
  });
}

export function parseExtensionActivation(input: unknown): ExtensionActivation {
  const value = extensionRecord(copyExtensionJson(input, 8_192), [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "pluginId",
    "revision",
    "configurationRevision",
    "configurationDigest",
    "state",
    "target",
    "updatedByActorId",
    "updatedAt",
  ]);
  if (value.schemaVersion !== "crewon.extension-activation.v0")
    extensionFailure("extension_activation_version_unsupported");
  if (
    value.state !== "enabled" &&
    value.state !== "disabled" &&
    value.state !== "revoked"
  )
    extensionFailure("extension_activation_state_invalid");
  if (value.state === "enabled" && value.target === null)
    extensionFailure("extension_execution_target_required");
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    ...parseExtensionScope(value as unknown as ExtensionScope),
    revision: extensionRevision(value.revision),
    configurationRevision: extensionRevision(value.configurationRevision),
    configurationDigest: extensionDigest(value.configurationDigest),
    state: value.state,
    target:
      value.target === null
        ? null
        : parseExtensionExecutionTarget(value.target),
    updatedByActorId: extensionOpaqueId(value.updatedByActorId),
    updatedAt: extensionTimestamp(value.updatedAt),
  });
}

export function extensionCanonicalJson(value: unknown): string {
  return JSON.stringify(copyExtensionJson(value, 65_536));
}
export function extensionOpaqueId(input: unknown): string {
  const value = extensionText(input, 128);
  if (/[\u0000-\u001f\u007f]/u.test(value))
    extensionFailure("extension_identity_invalid");
  return value;
}
export function extensionDigest(input: unknown): string {
  const value = extensionText(input, 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value))
    extensionFailure("extension_digest_invalid");
  return value;
}
export function extensionRevision(
  input: unknown,
  options: { minimum: 0 | 1 } = { minimum: 1 },
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < options.minimum ||
    input > 2_147_483_647
  )
    extensionFailure("extension_revision_invalid");
  return input;
}
export function extensionTimestamp(input: unknown): string {
  const value = extensionText(input, 24);
  if (
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    extensionFailure("extension_timestamp_invalid");
  return value;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
