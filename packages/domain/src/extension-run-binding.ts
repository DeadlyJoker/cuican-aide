import {
  extensionCanonicalJson,
  extensionDigest,
  extensionOpaqueId,
  extensionRevision,
  parseExtensionExecutionTarget,
  parseExtensionScope,
  type ExtensionContentDigester,
  type ExtensionExecutionTarget,
  type ExtensionScope,
} from "./extension-configuration.ts";
import {
  copyExtensionJson,
  extensionFailure,
  extensionRecord,
} from "./extension-validation.ts";

type ExtensionRunBindingFields = ExtensionScope &
  Readonly<{
    runId: string;
    threadId: string;
    actorId: string;
    configurationRevision: number;
    configurationDigest: string;
    target: ExtensionExecutionTarget;
    inputDigest: string;
    /** Null for new generation; an explicit, authorized source for a later query Run. */
    source: Readonly<{
      runId: string;
      operationId: string;
      bindingDigest: string;
    }> | null;
    bindingDigest: string;
  }>;

export type ExtensionRunBindingV0 = ExtensionRunBindingFields &
  Readonly<{ schemaVersion: "crewon.extension-run-binding.v0" }>;
export type ExtensionRunCompositionReference = Readonly<{
  profileId: string;
  authorityEpoch: string;
  revision: number;
  lockDigest: string;
}>;
export type ExtensionRunBindingV1 = ExtensionRunBindingFields &
  Readonly<{
    schemaVersion: "crewon.extension-run-binding.v1";
    composition: ExtensionRunCompositionReference;
  }>;
export type ExtensionRunBinding = ExtensionRunBindingV0 | ExtensionRunBindingV1;
export type ExtensionRunBindingInput =
  | Omit<ExtensionRunBindingV0, "bindingDigest">
  | Omit<ExtensionRunBindingV1, "bindingDigest">;

export function createExtensionRunBinding(
  input: ExtensionRunBindingInput,
  digester: ExtensionContentDigester,
): ExtensionRunBinding {
  const parsed = parseBinding({
    ...input,
    bindingDigest: `sha256:${"0".repeat(64)}`,
  });
  const { bindingDigest: _, ...body } = parsed;
  return parseExtensionRunBinding(
    { ...body, bindingDigest: digester.sha256(extensionCanonicalJson(body)) },
    digester,
  );
}

export function parseExtensionRunBinding(
  input: unknown,
  digester: ExtensionContentDigester,
): ExtensionRunBinding {
  const parsed = parseBinding(input);
  const { bindingDigest, ...body } = parsed;
  if (digester.sha256(extensionCanonicalJson(body)) !== bindingDigest)
    extensionFailure("extension_run_binding_digest_mismatch");
  return parsed;
}

function parseBinding(input: unknown): ExtensionRunBinding {
  const copied = copyExtensionJson(input, 8_192);
  if (!copied || typeof copied !== "object" || Array.isArray(copied))
    extensionFailure("extension_object_invalid");
  const schemaVersion = (copied as Record<string, unknown>).schemaVersion;
  if (
    schemaVersion !== "crewon.extension-run-binding.v0" &&
    schemaVersion !== "crewon.extension-run-binding.v1"
  )
    extensionFailure("extension_run_binding_version_unsupported");
  const value = extensionRecord(copied, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "pluginId",
    "runId",
    "threadId",
    "actorId",
    "configurationRevision",
    "configurationDigest",
    "target",
    "inputDigest",
    "source",
    "bindingDigest",
    ...(schemaVersion === "crewon.extension-run-binding.v1"
      ? ["composition"]
      : []),
  ]);
  const source =
    value.source === null
      ? null
      : extensionRecord(value.source, [
          "runId",
          "operationId",
          "bindingDigest",
        ]);
  const runId = extensionOpaqueId(value.runId);
  if (source !== null && source.runId === runId)
    extensionFailure("extension_query_source_invalid");
  const fields: ExtensionRunBindingFields = Object.freeze({
    ...parseExtensionScope(value as unknown as ExtensionScope),
    runId,
    threadId: extensionOpaqueId(value.threadId),
    actorId: extensionOpaqueId(value.actorId),
    configurationRevision: extensionRevision(value.configurationRevision),
    configurationDigest: extensionDigest(value.configurationDigest),
    target: parseExtensionExecutionTarget(value.target),
    inputDigest: extensionDigest(value.inputDigest),
    source:
      source === null
        ? null
        : Object.freeze({
            runId: extensionOpaqueId(source.runId),
            operationId: extensionOpaqueId(source.operationId),
            bindingDigest: extensionDigest(source.bindingDigest),
          }),
    bindingDigest: extensionDigest(value.bindingDigest),
  });
  if (schemaVersion === "crewon.extension-run-binding.v0")
    return Object.freeze({ ...fields, schemaVersion });
  const composition = extensionRecord(value.composition, [
    "profileId",
    "authorityEpoch",
    "revision",
    "lockDigest",
  ]);
  return Object.freeze({
    ...fields,
    schemaVersion,
    composition: Object.freeze({
      profileId: extensionOpaqueId(composition.profileId),
      authorityEpoch: extensionOpaqueId(composition.authorityEpoch),
      revision: extensionRevision(composition.revision),
      lockDigest: extensionDigest(composition.lockDigest),
    }),
  });
}
