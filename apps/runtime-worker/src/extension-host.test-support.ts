import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import {
  AgentVersionReleaseApplicationService,
  compileAgentVersionReleaseBundle,
  type ActorContext,
  type AuthorizationPort,
} from "@crewon/application";
import { createAgentVersionAsset } from "@crewon/agent-version";
import {
  createExtensionConfiguration,
  extensionCanonicalJson,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { compileRuntimeAgentVersion } from "./agent-version-release.ts";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import { comfyManifest } from "./extensions/comfyui-manifest.ts";
import { comfyToolDefinitions } from "./extensions/comfyui-tool-catalog.ts";
import {
  createRuntimeExtension,
  runtimeExtensionTarget,
} from "./extensions/extension-runtime-config.ts";
import { registerRuntimeExtensionMaterializations } from "./extensions/extension-runtime-proof.ts";
import { RuntimeExtensionHostService } from "./extensions/extension-host-service.ts";

export const hostActor: ActorContext = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
export const hostDigester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export const hostSignal = () => new AbortController().signal;

/** Real Store/resolver/factory/BoundComfy tools; model and external HTTP are never called. */
export async function extensionHostFixture(t: TestContext) {
  const store = new SqliteRunStore(":memory:");
  const extensions = store.extensionStore();
  await extensions.migrate();
  const operations = store.externalOperationStore();
  const manifest = comfyManifest();
  const registration = {
    manifest,
    manifestDigest: hostDigester.sha256(extensionCanonicalJson(manifest)),
    implementationDigest: `sha256:${"a".repeat(64)}`,
  };
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: hostActor.tenantId,
      spaceId: hostActor.spaceId,
      pluginId: manifest.pluginId,
      revision: 1,
      pluginVersion: manifest.version,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: { baseUrl: "https://comfy.example/" },
      credentialBindings: [],
      createdByActorId: hostActor.actorId,
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    hostDigester,
  );
  const snapshot = {
    schemaVersion: "crewon.extension-runtime-config.v0" as const,
    configuration,
    registration,
    approvalRequirement: "none" as const,
  };
  const route = {
    authorityId: "authority-1",
    runtimeGeneration: "runtime-1",
    agentVersionId: "agent-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
  };
  const transport = {
    adapterName: "fixture",
    adapterVersion: "1",
    modelId: "fixture-model",
    async *stream(): AsyncGenerator<never> {
      throw new Error("unexpected_model_request");
    },
  };
  const version = compileRuntimeAgentVersion({
    runtimeTenantId: hostActor.tenantId,
    route,
    transport,
    toolRuntime: new InMemoryToolBroker(comfyToolDefinitions()),
    agentInstructions: manifest.task.instructions,
  });
  const materializationDigest = `sha256:${"b".repeat(64)}`;
  const binding = {
    tenantId: hostActor.tenantId,
    agentVersionId: version.agentVersionId,
    contentDigest: version.contentDigest,
    authorityId: route.authorityId,
    workspaceBindingId: null,
    materializationDigest,
  };
  const target = runtimeExtensionTarget({
    snapshot,
    version,
    binding,
    materializationDigest,
  });
  const proof = {
    configuration,
    registration,
    target,
    approvalRequirement: snapshot.approvalRequirement,
  };
  const controls: {
    actor: ActorContext | null;
    allowed: boolean;
    toolsConstructed: number;
    acquired: number;
    released: number;
    afterAcquire?: () => void;
    omitProof?: boolean;
  } = {
    actor: hostActor,
    allowed: true,
    toolsConstructed: 0,
    acquired: 0,
    released: 0,
  };
  const authorization: AuthorizationPort = {
    authorize: async () =>
      controls.allowed
        ? { outcome: "allow" }
        : { outcome: "deny", reasonCode: "revoked" },
  };
  await store.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: hostActor.tenantId,
      version,
      createdAt: configuration.createdAt,
    }),
  );
  const deployment = {
    schemaVersion: "crewon.agent-version-deployment.v0" as const,
    ...binding,
  };
  const bundle = compileAgentVersionReleaseBundle(
    {
      tenantId: hostActor.tenantId,
      defaultAgentVersionId: version.agentVersionId,
      deployments: [deployment],
    },
    hostDigester,
  );
  await new AgentVersionReleaseApplicationService({
    store,
    authorization,
    digester: hostDigester,
    clock: { now: () => configuration.createdAt },
  }).activate(hostActor, bundle, "activation-1");
  const factory = new ConfiguredAgentVersionRuntimeFactory([
    {
      ...binding,
      executionAuthority: "crewonKernel",
      transportOwnership: "request",
      createTransport: () => transport,
      createToolRuntime: () => {
        controls.toolsConstructed++;
        const tools = createRuntimeExtension({
          snapshot,
          target,
          dependencies: {
            extensions,
            operations,
            runs: store,
            access: { authorize: async () => ({ outcome: "allow" }) },
            dns: {
              resolveAll: async () => {
                throw new Error("unexpected_dns");
              },
            },
            transport: {
              request: async () => {
                throw new Error("unexpected_comfy_request");
              },
            },
          },
        });
        if (!controls.omitProof)
          registerRuntimeExtensionMaterializations(tools, [proof]);
        return tools;
      },
    },
  ]);
  const registry = new InMemoryAgentVersionRuntimeRegistry(hostDigester);
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    store,
    digester: hostDigester,
    factory,
    registry,
  });
  t.after(async () => {
    resolver.close();
    await registry.close();
    await store.close();
  });
  const service = new RuntimeExtensionHostService({
    resolveActor: async () => controls.actor,
    authorization,
    deployments: store,
    registration: () => registration,
    runtimeResolver: {
      acquire: async (locator) => {
        controls.acquired++;
        const lease = await resolver.acquire(locator);
        controls.afterAcquire?.();
        return lease === null
          ? null
          : {
              resource: lease.resource,
              release: () => {
                controls.released++;
                lease.release();
              },
            };
      },
    },
  });
  const request = {
    protocol: "crewon.extension-host-request.v0",
    operation: "readiness",
    actor: hostActor,
    registration: {
      pluginId: manifest.pluginId,
      pluginVersion: manifest.version,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
    },
    configuration,
    agentVersionId: version.agentVersionId,
  };
  return {
    store,
    extensions,
    operations,
    configuration,
    registration,
    snapshot,
    target,
    proof,
    version,
    factory,
    registry,
    resolver,
    controls,
    authorization,
    service,
    request,
  };
}
