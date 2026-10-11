import { createHash } from "node:crypto";
import type { PluginCompositionStore } from "@crewon/application";
import {
  parsePluginCompositionLock,
  type PluginCompositionLock,
} from "@crewon/contracts/plugins";
import {
  parsePluginQueryTaskAdmission,
  type ExtensionRunBinding,
  type PluginTaskAdmission,
  type PluginQueryTaskAdmission,
} from "@crewon/domain";

const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
/** Original persisted metadata only. Package bytes and provider execution authority remain separate gates. */
export async function readInstalledPluginRunComposition(
  input: Readonly<{
    binding: ExtensionRunBinding;
    admission: PluginTaskAdmission;
    query?: PluginQueryTaskAdmission | null;
    compositions: Pick<PluginCompositionStore, "loadLock"> | undefined;
    signal: AbortSignal;
    fail(code: string): never;
  }>,
): Promise<PluginCompositionLock | null> {
  const { binding, admission, signal, fail } = input;
  if (binding.schemaVersion === "crewon.extension-run-binding.v0") return null;
  if (!input.compositions)
    return fail("installed_plugin_composition_execution_unavailable");
  const query =
    input.query == null ? null : parsePluginQueryTaskAdmission(input.query);
  if ((binding.source !== null) !== (query !== null))
    fail("installed_plugin_composition_query_unavailable");
  // The caller has checked the query against the stored source Run and operation.
  // Graph identity belongs to that source, while admission retains today's query authority.
  const graphAdmission = query?.source ?? admission;
  if (
    query !== null &&
    (query.runId !== binding.runId ||
      query.extensionBindingDigest !== binding.bindingDigest ||
      query.source.runId !== binding.source?.runId ||
      query.source.extensionBindingDigest !== binding.source?.bindingDigest ||
      query.operationId !== binding.source?.operationId)
  )
    fail("installed_plugin_composition_query_source_conflict");
  const reference = binding.composition;
  if (
    reference.profileId !== graphAdmission.profileId ||
    reference.authorityEpoch !== graphAdmission.authorityEpoch
  )
    fail("installed_plugin_composition_reference_conflict");
  const scope = Object.freeze({
    tenantId: binding.tenantId,
    spaceId: binding.spaceId,
    profileId: graphAdmission.profileId,
  });
  signal.throwIfAborted();
  const raw = await input.compositions.loadLock({
    scope,
    lockDigest: reference.lockDigest,
  });
  signal.throwIfAborted();
  if (raw === null) fail("installed_plugin_composition_missing");
  const lock = parsePluginCompositionLock(raw, digester);
  if (
    lock.scope.tenantId !== scope.tenantId ||
    lock.scope.spaceId !== scope.spaceId ||
    lock.scope.profileId !== scope.profileId ||
    lock.scope.authorityEpoch !== reference.authorityEpoch ||
    lock.revision !== reference.revision ||
    lock.lockDigest !== reference.lockDigest
  )
    fail("installed_plugin_composition_reference_conflict");
  const root = lock.nodes.find((node) => node.pluginId === binding.pluginId);
  if (
    !root ||
    root.publisherId !== graphAdmission.publisherId ||
    root.version !== graphAdmission.version ||
    root.packageDigest !== graphAdmission.packageDigest ||
    root.selectionRevision !== graphAdmission.selectionRevision
  )
    fail("installed_plugin_composition_root_conflict");
  return lock;
}
