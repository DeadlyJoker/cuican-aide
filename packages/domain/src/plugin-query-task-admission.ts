import { extensionCanonicalJson } from "./extension-configuration.ts";
import {
  parseExtensionRunBinding,
  type ExtensionRunBinding,
} from "./extension-run-binding.ts";
import type { ExtensionContentDigester } from "./extension-configuration.ts";
import {
  assertPluginTaskAdmission,
  parsePluginTaskAdmission,
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmission,
  type PluginTaskAdmissionPin,
} from "./plugin-task-admission.ts";
import {
  pluginInstallationDigest,
  pluginInstallationOpaqueId,
  pluginInstallationRecord,
} from "./plugin-installation-validation.ts";

/** Current invocation authority and original execution provenance remain distinct. */
export type PluginQueryTaskAdmission = PluginTaskAdmissionPin &
  Readonly<{
    schemaVersion: "crewon.plugin-query-task-admission.v1";
    runId: string;
    threadId: string;
    extensionBindingDigest: string;
    requestDigest: string;
    idempotencyKey: string;
    source: PluginTaskAdmission;
    operationId: string;
  }>;
const fields = [
  "schemaVersion",
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
  "runId",
  "threadId",
  "extensionBindingDigest",
  "requestDigest",
  "idempotencyKey",
  "source",
  "operationId",
] as const;
export function parsePluginQueryTaskAdmission(
  input: unknown,
): PluginQueryTaskAdmission {
  const value = pluginInstallationRecord(input, fields);
  if (value.schemaVersion !== "crewon.plugin-query-task-admission.v1")
    throw new Error("plugin_query_admission_schema_unsupported");
  const pin = parsePluginTaskAdmissionPin(
    Object.fromEntries(
      Object.entries(value).filter(
        ([key]) =>
          ![
            "schemaVersion",
            "runId",
            "threadId",
            "extensionBindingDigest",
            "requestDigest",
            "idempotencyKey",
            "source",
            "operationId",
          ].includes(key),
      ),
    ),
  );
  const operationId = pluginInstallationOpaqueId(value.operationId);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      operationId,
    )
  )
    throw new Error("plugin_query_operation_invalid");
  return Object.freeze({
    schemaVersion: "crewon.plugin-query-task-admission.v1",
    ...pin,
    runId: pluginInstallationOpaqueId(value.runId),
    threadId: pluginInstallationOpaqueId(value.threadId),
    extensionBindingDigest: pluginInstallationDigest(
      value.extensionBindingDigest,
    ),
    requestDigest: pluginInstallationDigest(value.requestDigest),
    idempotencyKey: pluginInstallationOpaqueId(value.idempotencyKey),
    source: parsePluginTaskAdmission(value.source),
    operationId,
  });
}
export function assertPluginQueryTaskAdmission(
  input: Readonly<{
    admission: PluginQueryTaskAdmission;
    binding: ExtensionRunBinding;
    sourceBinding: ExtensionRunBinding;
    receipt: Readonly<{
      actorId: string;
      idempotencyKey: string;
      requestDigest: string;
    }>;
  }>,
  digester: ExtensionContentDigester,
): PluginQueryTaskAdmission {
  const admission = parsePluginQueryTaskAdmission(input.admission);
  const binding = parseExtensionRunBinding(input.binding, digester);
  const source = parseExtensionRunBinding(input.sourceBinding, digester);
  assertPluginTaskAdmission(
    {
      admission: admission.source,
      binding: source,
      receipt: {
        actorId: admission.source.actorId,
        idempotencyKey: admission.source.idempotencyKey,
        requestDigest: admission.source.requestDigest,
      },
    },
    digester,
  );
  if (
    binding.source === null ||
    ["tenantId", "spaceId", "pluginId", "actorId", "runId", "threadId"].some(
      (key) =>
        admission[key as keyof PluginQueryTaskAdmission] !==
        binding[key as keyof ExtensionRunBinding],
    ) ||
    admission.extensionBindingDigest !== binding.bindingDigest ||
    admission.actorId !== input.receipt.actorId ||
    admission.requestDigest !== input.receipt.requestDigest ||
    admission.idempotencyKey !== input.receipt.idempotencyKey ||
    ["tenantId", "spaceId", "profileId", "pluginId", "publisherId"].some(
      (key) =>
        admission[key as keyof PluginTaskAdmissionPin] !==
        admission.source[key as keyof PluginTaskAdmission],
    ) ||
    binding.source.runId !== source.runId ||
    binding.source.bindingDigest !== source.bindingDigest ||
    binding.source.operationId !== admission.operationId ||
    binding.runId === source.runId ||
    binding.configurationRevision !== source.configurationRevision ||
    binding.configurationDigest !== source.configurationDigest ||
    extensionCanonicalJson(binding.target) !==
      extensionCanonicalJson(source.target)
  )
    throw new Error("plugin_query_admission_binding_mismatch");
  return admission;
}
/** Execution-only projection: it is never a generation admission or permission grant. */
export function effectivePluginQueryTaskAdmission(
  input: PluginQueryTaskAdmission,
): PluginTaskAdmission {
  const query = parsePluginQueryTaskAdmission(input);
  return Object.freeze({
    ...query.source,
    principalId: query.principalId,
    actorId: query.actorId,
    contributionId: query.contributionId,
    action: query.action,
    authorityEpoch: query.authorityEpoch,
    runId: query.runId,
    threadId: query.threadId,
    extensionBindingDigest: query.extensionBindingDigest,
    requestDigest: query.requestDigest,
    idempotencyKey: query.idempotencyKey,
  });
}
