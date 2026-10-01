import type {
  ActorContext,
  AgentVersionDeploymentStore,
  AuthorizationPort,
  ExtensionRegistration,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseExtensionExecutionTarget,
} from "@crewon/domain";
import {
  parseExtensionHostActor,
  parseExtensionHostRequest,
  parseExtensionHostResponse,
  type ExtensionHostRequest,
  type ExtensionHostResponse,
  type ExtensionHostReadinessResult,
  type ExtensionHostRegistrationIdentity,
} from "@crewon/contracts";
import type { StoreBackedAgentVersionRuntimeResolver } from "../store-backed-agent-version-runtime-resolver.ts";
import { bundledComfyRegistration } from "./comfyui-bundled-registration.ts";
import { validateComfyConfiguration } from "./extension-runtime-config.ts";
import { comfyToolDefinitions } from "./comfyui-tool-catalog.ts";
import { parseRuntimeExtensionMaterialization } from "./extension-runtime-proof.ts";

export type RuntimeExtensionActorResolver = (
  owner: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
  signal: AbortSignal,
) => Promise<ActorContext | null>;

/** Private host authority backed by the same resolver that actually executes Worker Runs. */
export class RuntimeExtensionHostService {
  readonly #resolveActor: RuntimeExtensionActorResolver;
  readonly #authorization: AuthorizationPort;
  readonly #runtimeResolver: Pick<
    StoreBackedAgentVersionRuntimeResolver,
    "acquire"
  >;
  readonly #deployments: Pick<
    AgentVersionDeploymentStore,
    "loadAgentVersionDeployment"
  >;
  readonly #registration: () => ExtensionRegistration;
  constructor(input: {
    resolveActor: RuntimeExtensionActorResolver;
    authorization: AuthorizationPort;
    runtimeResolver: Pick<StoreBackedAgentVersionRuntimeResolver, "acquire">;
    deployments: Pick<
      AgentVersionDeploymentStore,
      "loadAgentVersionDeployment"
    >;
    registration?: () => ExtensionRegistration;
  }) {
    this.#resolveActor = input.resolveActor;
    this.#authorization = input.authorization;
    this.#runtimeResolver = input.runtimeResolver;
    this.#deployments = input.deployments;
    const registration = input.registration ?? bundledComfyRegistration;
    this.#registration = () => {
      const current = registration();
      return Object.freeze({
        manifest: current.manifest,
        manifestDigest: current.manifestDigest,
        implementationDigest: current.implementationDigest,
      });
    };
  }

  async handle(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ExtensionHostResponse> {
    const request = parseExtensionHostRequest(input);
    signal.throwIfAborted();
    const registration = this.#registration();
    await this.#authorize(request, registration.manifest.pluginId, signal);
    const common = {
      protocol: "crewon.extension-host-response.v0",
      operation: request.operation,
      actor: request.actor,
    } as const;
    if (request.operation === "catalog") {
      await this.#authorize(request, registration.manifest.pluginId, signal);
      return parseExtensionHostResponse({
        ...common,
        operation: "catalog",
        registrations: [registration],
      });
    }
    if (!sameRegistration(request.registration, registration))
      throw new RuntimeExtensionHostError(
        "extension_implementation_unavailable",
      );
    const configuration = validateComfyConfiguration(
      request.configuration,
      registration,
    );
    if (
      configuration.tenantId !== request.actor.tenantId ||
      configuration.spaceId !== request.actor.spaceId
    )
      throw new RuntimeExtensionHostError("extension_host_identity_invalid");
    const configured = {
      ...common,
      registration: request.registration,
      configurationDigest: configuration.contentDigest,
    };
    if (request.operation === "validateConfiguration") {
      await this.#authorize(request, registration.manifest.pluginId, signal);
      return parseExtensionHostResponse({
        ...configured,
        operation: "validateConfiguration",
      });
    }
    let result: ExtensionHostReadinessResult;
    let lease: Awaited<
      ReturnType<StoreBackedAgentVersionRuntimeResolver["acquire"]>
    > = null;
    try {
      const deployment = await this.#deployments.loadAgentVersionDeployment({
        tenantId: request.actor.tenantId,
        agentVersionId: request.agentVersionId,
      });
      signal.throwIfAborted();
      if (
        deployment === null ||
        deployment.tenantId !== request.actor.tenantId ||
        deployment.agentVersionId !== request.agentVersionId
      ) {
        result = unavailable("extension_runtime_unavailable");
      } else {
        lease = await this.#runtimeResolver.acquire({
          tenantId: request.actor.tenantId,
          agentVersionId: request.agentVersionId,
        });
        signal.throwIfAborted();
        if (lease === null)
          result = unavailable("extension_runtime_unavailable");
        else {
          const runtime = lease.resource;
          if (runtime.executionAuthority !== "crewonKernel")
            result = unavailable("extension_execution_authority_unsupported");
          else {
            const rawProof = runtime.extensions?.find(
              (entry) =>
                entry.configuration.pluginId === configuration.pluginId,
            );
            if (rawProof === undefined)
              result = unavailable("extension_implementation_unavailable");
            else {
              const proof = parseRuntimeExtensionMaterialization(rawProof);
              const target = parseExtensionExecutionTarget(proof.target);
              if (
                extensionCanonicalJson(proof.configuration) !==
                  extensionCanonicalJson(configuration) ||
                !sameRegistration(request.registration, proof.registration) ||
                runtime.version.agentVersionId !== target.agentVersionId ||
                runtime.version.contentDigest !==
                  target.agentVersionContentDigest ||
                runtime.version.runtimeGeneration !==
                  target.runtimeGeneration ||
                runtime.version.policySnapshotId !== target.policySnapshotId ||
                deployment.contentDigest !== target.agentVersionContentDigest ||
                deployment.materializationDigest !==
                  target.materializationDigest ||
                deployment.authorityId !== target.authorityId ||
                deployment.workspaceBindingId !== target.workspaceBindingId ||
                target.agentVersionId !== request.agentVersionId ||
                configuration.tenantId !== request.actor.tenantId ||
                !comfyToolDefinitions().every(
                  (definition) =>
                    runtime.version.tools.some(
                      (tool) =>
                        extensionCanonicalJson(tool) ===
                        extensionCanonicalJson(definition),
                    ) &&
                    runtime.toolRuntime
                      .definitions()
                      .some(
                        (tool) =>
                          extensionCanonicalJson(tool) ===
                          extensionCanonicalJson(definition),
                      ),
                )
              )
                result = unavailable("extension_runtime_unavailable");
              else
                result = {
                  outcome: "ready",
                  target: JSON.parse(JSON.stringify(target)),
                };
            }
          }
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      result = unavailable(
        error instanceof Error &&
          (error.message === "extension_implementation_unavailable" ||
            error.message === "extension_implementation_mismatch" ||
            error.message === "extension_source_changed_since_load")
          ? "extension_implementation_unavailable"
          : "extension_runtime_unavailable",
      );
    } finally {
      lease?.release();
    }
    await this.#authorize(request, registration.manifest.pluginId, signal);
    return parseExtensionHostResponse({
      ...configured,
      operation: "readiness",
      agentVersionId: request.agentVersionId,
      result,
    });
  }

  async #authorize(
    request: ExtensionHostRequest,
    pluginId: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const current = await this.#resolveActor(
      {
        tenantId: request.actor.tenantId,
        spaceId: request.actor.spaceId,
        actorId: request.actor.actorId,
      },
      signal,
    );
    signal.throwIfAborted();
    const actor = current === null ? null : parseExtensionHostActor(current);
    if (
      actor === null ||
      actor.actorId !== request.actor.actorId ||
      actor.principalId !== request.actor.principalId ||
      actor.tenantId !== request.actor.tenantId ||
      actor.spaceId !== request.actor.spaceId
    )
      throw new RuntimeExtensionHostError("extension_host_identity_invalid");
    const decision = await this.#authorization.authorize({
      actor,
      action: "extension:read",
      resource: {
        kind: "extension",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        pluginId,
      },
    });
    signal.throwIfAborted();
    if (decision.outcome !== "allow")
      throw new RuntimeExtensionHostError(
        "extension_host_authorization_denied",
      );
    if (request.operation === "readiness") {
      const agent = await this.#authorization.authorize({
        actor,
        action: "agentVersion:read",
        resource: {
          kind: "agentVersion",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          agentVersionId: request.agentVersionId,
        },
      });
      signal.throwIfAborted();
      if (agent.outcome !== "allow")
        throw new RuntimeExtensionHostError(
          "extension_host_authorization_denied",
        );
    }
  }
}
export class RuntimeExtensionHostError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "RuntimeExtensionHostError";
    this.code = code;
  }
}
function sameRegistration(
  identity: ExtensionHostRegistrationIdentity,
  registration: ExtensionRegistration,
): boolean {
  return (
    identity.pluginId === registration.manifest.pluginId &&
    identity.pluginVersion === registration.manifest.version &&
    identity.manifestDigest === registration.manifestDigest &&
    identity.implementationDigest === registration.implementationDigest
  );
}
function unavailable(
  reasonCode: Extract<
    ExtensionHostReadinessResult,
    { outcome: "unavailable" }
  >["reasonCode"],
): ExtensionHostReadinessResult {
  return { outcome: "unavailable", reasonCode };
}
