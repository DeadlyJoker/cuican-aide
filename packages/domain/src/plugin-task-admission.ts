import {
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationOpaqueId,
  pluginInstallationRecord,
  pluginInstallationRevision,
  pluginInstallationVersion,
} from "./plugin-installation-validation.ts";
import {
  parseExtensionRunBinding,
  type ExtensionRunBinding,
} from "./extension-run-binding.ts";
import type { ExtensionContentDigester } from "./extension-configuration.ts";
import type { ExtensionCreditCommandIdentity } from "./extension-credit-admission.ts";

/** Server-derived invocation authority. A package declaration alone never supplies this pin. */
export type PluginTaskAdmissionPin = Readonly<{
  tenantId: string;
  spaceId: string;
  profileId: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  selectionRevision: number;
  principalId: string;
  actorId: string;
  contributionId: string;
  action: string;
  authorityEpoch: string;
}>;

/** Separate v1 provenance; adding it does not change the strict v0 ExtensionRunBinding digest. */
export type PluginTaskAdmission = PluginTaskAdmissionPin &
  Readonly<{
    schemaVersion: "crewon.plugin-task-admission.v1";
    runId: string;
    threadId: string;
    extensionBindingDigest: string;
    requestDigest: string;
    /** Effective receipt key, namespaced by the host rather than by an ephemeral invocation reference. */
    idempotencyKey: string;
  }>;

export class PluginTaskAdmissionError extends Error {
  readonly code: string;
  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "PluginTaskAdmissionError";
    this.code = code;
  }
}
const pinFields = [
  "tenantId",
  "spaceId",
  "profileId",
  "pluginId",
  "publisherId",
  "version",
  "packageDigest",
  "selectionRevision",
  "principalId",
  "actorId",
  "contributionId",
  "action",
  "authorityEpoch",
] as const;
const admissionFields = [
  "schemaVersion",
  ...pinFields,
  "runId",
  "threadId",
  "extensionBindingDigest",
  "requestDigest",
  "idempotencyKey",
] as const;

function checked<T>(code: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof PluginTaskAdmissionError) throw error;
    throw new PluginTaskAdmissionError(code, { cause: error });
  }
}
function opaque(input: unknown): string {
  return checked("plugin_task_admission_identity_invalid", () =>
    pluginInstallationOpaqueId(input),
  );
}
function digest(input: unknown): string {
  return checked("plugin_task_admission_digest_invalid", () =>
    pluginInstallationDigest(input),
  );
}
function namespace(input: unknown): string {
  return checked("plugin_task_admission_namespace_invalid", () =>
    pluginInstallationNamespaceId(input),
  );
}
function pin(value: Readonly<Record<string, unknown>>): PluginTaskAdmissionPin {
  if (
    typeof value.action !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/u.test(value.action)
  )
    throw new PluginTaskAdmissionError("plugin_task_admission_action_invalid");
  return Object.freeze({
    tenantId: opaque(value.tenantId),
    spaceId: opaque(value.spaceId),
    profileId: opaque(value.profileId),
    pluginId: namespace(value.pluginId),
    publisherId: namespace(value.publisherId),
    version: checked("plugin_task_admission_package_version_invalid", () =>
      pluginInstallationVersion(value.version),
    ),
    packageDigest: digest(value.packageDigest),
    selectionRevision: checked("plugin_task_admission_revision_invalid", () =>
      pluginInstallationRevision(value.selectionRevision),
    ),
    principalId: opaque(value.principalId),
    actorId: opaque(value.actorId),
    contributionId: namespace(value.contributionId),
    action: value.action,
    authorityEpoch: opaque(value.authorityEpoch),
  });
}
export function parsePluginTaskAdmissionPin(
  input: unknown,
): PluginTaskAdmissionPin {
  return pin(
    checked("plugin_task_admission_fields_invalid", () =>
      pluginInstallationRecord(input, pinFields),
    ),
  );
}
export function parsePluginTaskAdmission(input: unknown): PluginTaskAdmission {
  const value = checked("plugin_task_admission_fields_invalid", () =>
    pluginInstallationRecord(input, admissionFields),
  );
  if (value.schemaVersion !== "crewon.plugin-task-admission.v1")
    throw new PluginTaskAdmissionError(
      "plugin_task_admission_schema_unsupported",
    );
  return Object.freeze({
    schemaVersion: "crewon.plugin-task-admission.v1",
    ...pin(value),
    runId: opaque(value.runId),
    threadId: opaque(value.threadId),
    extensionBindingDigest: digest(value.extensionBindingDigest),
    requestDigest: digest(value.requestDigest),
    idempotencyKey: opaque(value.idempotencyKey),
  });
}

/** Verifies persisted links against the original versioned binding and receipt; this is not selection authorization. */
export function assertPluginTaskAdmission(
  input: Readonly<{
    admission: PluginTaskAdmission;
    binding: ExtensionRunBinding;
    receipt: ExtensionCreditCommandIdentity;
  }>,
  digester: ExtensionContentDigester,
): PluginTaskAdmission {
  const admission = parsePluginTaskAdmission(input.admission);
  const binding = checked("plugin_task_admission_binding_invalid", () =>
    parseExtensionRunBinding(input.binding, digester),
  );
  if (
    (binding.schemaVersion === "crewon.extension-run-binding.v1" &&
      (binding.composition.profileId !== admission.profileId ||
        binding.composition.authorityEpoch !== admission.authorityEpoch)) ||
    binding.source !== null ||
    admission.tenantId !== binding.tenantId ||
    admission.spaceId !== binding.spaceId ||
    admission.pluginId !== binding.pluginId ||
    admission.actorId !== binding.actorId ||
    admission.runId !== binding.runId ||
    admission.threadId !== binding.threadId ||
    admission.extensionBindingDigest !== binding.bindingDigest ||
    admission.actorId !== input.receipt.actorId ||
    admission.idempotencyKey !== input.receipt.idempotencyKey ||
    admission.requestDigest !== input.receipt.requestDigest
  )
    throw new PluginTaskAdmissionError(
      "plugin_task_admission_binding_mismatch",
    );
  return admission;
}
