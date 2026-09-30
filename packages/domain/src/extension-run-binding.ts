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

export type ExtensionRunBinding = ExtensionScope &
  Readonly<{
    schemaVersion: "crewon.extension-run-binding.v0";
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

export function createExtensionRunBinding(
  input: Omit<ExtensionRunBinding, "bindingDigest">,
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
  const value = extensionRecord(copyExtensionJson(input, 8_192), [
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
  ]);
  if (value.schemaVersion !== "crewon.extension-run-binding.v0")
    extensionFailure("extension_run_binding_version_unsupported");
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
  return Object.freeze({
    schemaVersion: value.schemaVersion,
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
}
