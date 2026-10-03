import type {
  ActorContext,
  AgentVersionDeploymentStore,
  ExtensionReadiness,
  ExtensionRegistration,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  type ExtensionConfiguration,
  type PluginProfileScope,
} from "@crewon/domain";
import type {
  PluginActivationCandidate,
  PluginExecutionPackage,
} from "@crewon/plugin-host";
import type { AgentVersionRuntime } from "../agent-version-runtime.ts";
import type { StoreBackedAgentVersionRuntimeResolver } from "../store-backed-agent-version-runtime-resolver.ts";
import { extensionToolDefinitions } from "../extensions/extension-tool-catalog.ts";
import { parseRuntimeExtensionMaterialization } from "../extensions/extension-runtime-proof.ts";
import { readInstalledPluginAgentRuntimeScope } from "./installed-plugin-agent-runtime-factory-proof.ts";
import {
  revalidateInstalledPluginBusinessRegistration,
  type InstalledPluginBusinessRegistration,
} from "./installed-plugin-business-registration.ts";
import type { InstalledPluginExecutionReadinessPort } from "./installed-plugin-execution-readiness-types.ts";

type RequestFacts = Readonly<{
  actor: ActorContext;
  registration: InstalledPluginBusinessRegistration;
  configuration: ExtensionConfiguration;
  agentVersionId: string | null;
}>;
export type InstalledPluginReadinessRequest = RequestFacts &
  (
    | Readonly<{ kind: "execution" }>
    | Readonly<{
        kind: "candidate";
        agentVersionId: string;
        expectedSelectionRevision: number;
      }>
  );

type ReadinessInput = Readonly<{
  request: InstalledPluginReadinessRequest;
  scope: PluginProfileScope;
  signal: AbortSignal;
  acquire: StoreBackedAgentVersionRuntimeResolver["acquire"];
  loadDeployment: AgentVersionDeploymentStore["loadAgentVersionDeployment"];
  authorize(): Promise<void>;
  authorizeCandidate(candidate: PluginActivationCandidate): Promise<void>;
  openPackage(): Promise<
    Readonly<{
      loading: Promise<PluginExecutionPackage>;
      candidate: PluginActivationCandidate | null;
    }>
  >;
  isOpen(): boolean;
  executionReadiness?: InstalledPluginExecutionReadinessPort;
}>;

/** Internal core; resource allocation and physical lifetime remain with the actual host/resolver/IO owners. */
export async function evaluateInstalledPluginReadiness(
  input: ReadinessInput,
): Promise<ExtensionReadiness> {
  const { request, signal } = input;
  await input.authorize();
  await revalidateInstalledPluginBusinessRegistration(
    request.registration,
    signal,
  );
  await input.authorize();
  let lease: Awaited<
    ReturnType<StoreBackedAgentVersionRuntimeResolver["acquire"]>
  > = null;
  let packageOwner: PluginExecutionPackage | null = null;
  let packageCandidate: PluginActivationCandidate | null = null;
  let finalReadiness: (() => ExtensionReadiness) | null = null;
  try {
    let result: ExtensionReadiness;
    try {
      const deployment = await input.loadDeployment({
        tenantId: input.scope.tenantId,
        agentVersionId: request.agentVersionId!,
      });
      await input.authorize();
      if (deployment === null)
        result = unavailable("extension_runtime_unavailable");
      else {
        lease = await input.acquire({
          tenantId: input.scope.tenantId,
          agentVersionId: request.agentVersionId!,
        });
        await input.authorize();
        if (lease === null)
          result = unavailable("extension_runtime_unavailable");
        else {
          result = runtimeReadiness(
            request,
            input.scope,
            lease.resource,
            deployment,
          );
          if (result.outcome === "ready") {
            const entry = await input.openPackage();
            if (entry.candidate === null)
              fail("installed_plugin_extension_host_candidate_missing");
            packageCandidate = entry.candidate;
            await input.authorizeCandidate(entry.candidate);
            const owner = await entry.loading;
            signal.throwIfAborted();
            packageOwner = owner;
            const currentDeployment = await input.loadDeployment({
              tenantId: input.scope.tenantId,
              agentVersionId: request.agentVersionId!,
            });
            await input.authorize();
            if (!same(deployment, currentDeployment))
              result = unavailable("extension_runtime_unavailable");
            else
              result = runtimeReadiness(
                request,
                input.scope,
                lease.resource,
                deployment,
              );
            const runtime = lease.resource;
            finalReadiness = () =>
              runtimeReadiness(request, input.scope, runtime, deployment);
          }
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      result = unavailable("extension_runtime_unavailable");
    }
    // Runtime failures cannot turn a revoked caller into an authorized response.
    await revalidateInstalledPluginBusinessRegistration(
      request.registration,
      signal,
    );
    if (result.outcome === "ready" && packageCandidate !== null) {
      try {
        await input.authorizeCandidate(packageCandidate);
      } catch {
        signal.throwIfAborted();
        result = unavailable("extension_runtime_unavailable");
      }
    }
    await input.authorize();
    if (result.outcome === "ready") {
      try {
        if (finalReadiness === null)
          fail("installed_plugin_extension_host_runtime_missing");
        result = finalReadiness();
        if (result.outcome !== "ready") return result;
        if (packageOwner === null)
          fail("installed_plugin_extension_host_owner_missing");
        const borrow = packageOwner.acquire({
          purpose: "newOperation",
          authorizeBorrow: (identity) =>
            input.isOpen() &&
            !signal.aborted &&
            same(identity, {
              pluginId: request.registration.identity.pluginId,
              version: request.registration.identity.version,
              packageDigest: request.registration.identity.packageDigest,
            })
              ? "allow"
              : "deny",
        });
        try {
          const requiredServices = borrow.factory.requiredServices ?? [];
          if (requiredServices.length > 0) {
            const gate = input.executionReadiness;
            if (gate === undefined)
              fail("installed_plugin_execution_services_unavailable");
            await gate.assertReady(
              {
                metadata: {
                  identity: request.registration.identity,
                  scope: input.scope,
                  configuration: request.configuration,
                  target: result.target,
                  purpose: "submit",
                },
                requiredServices,
              },
              signal,
            );
            await input.authorizeCandidate(packageCandidate!);
            await revalidateInstalledPluginBusinessRegistration(
              request.registration,
              signal,
            );
            const currentDeployment = await input.loadDeployment({
              tenantId: input.scope.tenantId,
              agentVersionId: request.agentVersionId!,
            });
            if (currentDeployment === null)
              fail("installed_plugin_extension_host_runtime_missing");
            await input.authorize();
            result = runtimeReadiness(
              request,
              input.scope,
              lease!.resource,
              currentDeployment,
            );
          }
        } finally {
          borrow.release();
        }
      } catch {
        result = unavailable("extension_runtime_unavailable");
      }
    }
    await input.authorize();
    if (result.outcome === "ready") {
      try {
        if (packageOwner === null)
          fail("installed_plugin_extension_host_owner_missing");
        // Every asynchronous gate precedes this actual factory check and synchronous return.
        const finalBorrow = packageOwner.acquire({
          purpose: "newOperation",
          authorizeBorrow: (identity) =>
            input.isOpen() &&
            !signal.aborted &&
            same(identity, {
              pluginId: request.registration.identity.pluginId,
              version: request.registration.identity.version,
              packageDigest: request.registration.identity.packageDigest,
            })
              ? "allow"
              : "deny",
        });
        finalBorrow.release();
      } catch {
        result = unavailable("extension_runtime_unavailable");
      }
    }
    return result;
  } finally {
    lease?.release();
  }
}

function runtimeReadiness(
  request: InstalledPluginReadinessRequest,
  scope: PluginProfileScope,
  runtime: AgentVersionRuntime,
  deployment: NonNullable<
    Awaited<
      ReturnType<AgentVersionDeploymentStore["loadAgentVersionDeployment"]>
    >
  >,
): ExtensionReadiness {
  if (runtime.executionAuthority !== "crewonKernel")
    return unavailable("extension_execution_authority_unsupported");
  if (
    !same(readInstalledPluginAgentRuntimeScope(runtime), scope) ||
    runtime.extensions?.length !== 1
  )
    return unavailable("extension_implementation_unavailable");
  const proof = parseRuntimeExtensionMaterialization(runtime.extensions[0]);
  const target = proof.target;
  const declared = extensionToolDefinitions(request.registration.manifest);
  const actualTools = runtime.toolRuntime.definitions();
  if (
    !same(proof.configuration, request.configuration) ||
    !same(project(proof.registration), project(request.registration)) ||
    target.agentVersionId !== request.agentVersionId ||
    runtime.version.agentVersionId !== target.agentVersionId ||
    runtime.version.contentDigest !== target.agentVersionContentDigest ||
    runtime.version.runtimeGeneration !== target.runtimeGeneration ||
    runtime.version.policySnapshotId !== target.policySnapshotId ||
    deployment.tenantId !== scope.tenantId ||
    deployment.agentVersionId !== target.agentVersionId ||
    deployment.contentDigest !== target.agentVersionContentDigest ||
    deployment.materializationDigest !== target.materializationDigest ||
    deployment.authorityId !== target.authorityId ||
    deployment.workspaceBindingId !== target.workspaceBindingId ||
    !same(actualTools, runtime.version.tools) ||
    !declared.every((definition) =>
      runtime.version.tools.some((tool) => same(tool, definition)),
    )
  )
    return unavailable("extension_runtime_unavailable");
  return Object.freeze({
    outcome: "ready",
    target: JSON.parse(extensionCanonicalJson(target)),
  });
}

function project(registration: ExtensionRegistration): ExtensionRegistration {
  return {
    manifest: registration.manifest,
    manifestDigest: registration.manifestDigest,
    implementationDigest: registration.implementationDigest,
  };
}
function same(left: unknown, right: unknown): boolean {
  return extensionCanonicalJson(left) === extensionCanonicalJson(right);
}
function unavailable(
  reasonCode: Extract<
    ExtensionReadiness,
    { outcome: "unavailable" }
  >["reasonCode"],
): ExtensionReadiness {
  return Object.freeze({ outcome: "unavailable", reasonCode });
}
function fail(code: string): never {
  throw new Error(code);
}
