import { createHash } from "node:crypto";
import type { PluginCompositionStore } from "@crewon/application";
import {
  parsePluginCompositionLock,
  type PluginCompositionLock,
} from "@crewon/contracts/plugins";
import type { ExtensionRunBinding, PluginTaskAdmission } from "@crewon/domain";

const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
/** Original persisted metadata only. Package bytes and provider execution authority remain separate gates. */
export async function readInstalledPluginRunComposition(
  input: Readonly<{
    binding: ExtensionRunBinding;
    admission: PluginTaskAdmission;
    compositions: Pick<PluginCompositionStore, "loadLock"> | undefined;
    signal: AbortSignal;
    fail(code: string): never;
  }>,
): Promise<PluginCompositionLock | null> {
  const { binding, admission, signal, fail } = input;
  if (binding.schemaVersion === "crewon.extension-run-binding.v0") return null;
  if (!input.compositions)
    return fail("installed_plugin_composition_execution_unavailable");
  if (binding.source !== null)
    fail("installed_plugin_composition_query_unavailable");
  const reference = binding.composition;
  if (
    reference.profileId !== admission.profileId ||
    reference.authorityEpoch !== admission.authorityEpoch
  )
    fail("installed_plugin_composition_reference_conflict");
  const scope = Object.freeze({
    tenantId: binding.tenantId,
    spaceId: binding.spaceId,
    profileId: admission.profileId,
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
    root.publisherId !== admission.publisherId ||
    root.version !== admission.version ||
    root.packageDigest !== admission.packageDigest ||
    root.selectionRevision !== admission.selectionRevision
  )
    fail("installed_plugin_composition_root_conflict");
  return lock;
}
