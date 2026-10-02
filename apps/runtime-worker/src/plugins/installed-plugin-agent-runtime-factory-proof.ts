import type { PluginProfileScope } from "@crewon/domain";
import type { AgentVersionRuntime } from "../agent-version-runtime.ts";
import type { RuntimeExtensionMaterialization } from "../extensions/extension-runtime-proof.ts";

const scopes = new WeakMap<AgentVersionRuntime, PluginProfileScope>();
const proofs = new WeakSet<RuntimeExtensionMaterialization>();

/** Private construction attestation. A copied DTO is never a new runtime authority. */
export function registerInstalledPluginAgentRuntimeScope(
  runtime: AgentVersionRuntime,
  scope: PluginProfileScope,
): void {
  if (runtime.extensions === undefined || runtime.extensions.length !== 1)
    throw new Error("installed_plugin_agent_runtime_proof_missing");
  scopes.set(runtime, Object.freeze({ ...scope }));
  proofs.add(runtime.extensions[0]!);
}

/** Old v0 owners retain their existing proof contract without acquiring a profile claim. */
export function readInstalledPluginAgentRuntimeScope(
  runtime: AgentVersionRuntime,
): PluginProfileScope | null {
  const scope = scopes.get(runtime);
  if (scope !== undefined) return scope;
  if (runtime.extensions?.some((proof) => proofs.has(proof)))
    throw new Error("installed_plugin_agent_runtime_scope_unverified");
  return null;
}
