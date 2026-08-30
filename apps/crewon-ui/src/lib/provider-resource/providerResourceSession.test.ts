import { describe, expect, it, vi } from "vitest";

import type { ProviderConnectionProjection } from "@crewon/app-server-protocol/platform/v2/ProviderConnectionProjection";
import type { ResourceBindingProjection } from "@crewon/app-server-protocol/platform/v2/ResourceBindingProjection";
import type { ResourceRef } from "@crewon/app-server-protocol/platform/v2/ResourceRef";
import type { WorkspaceRef } from "@crewon/app-server-protocol/platform/v2/WorkspaceRef";

import {
  ProviderResourceSession,
  type ProviderResourceApi,
} from "./providerResourceSession";

const agentResource: ResourceRef = {
  providerId: "agent-platform",
  resourceId: "agent-1",
  revision: "r1",
  resourceType: "agent",
};

const skillResource: ResourceRef = {
  providerId: "agent-platform",
  resourceId: "skill-1",
  revision: "r2",
  resourceType: "skill",
};

const mcpToolResource: ResourceRef = {
  providerId: "agent-platform",
  resourceId: "mcp-tool-1",
  revision: "r3",
  resourceType: "mcpTool",
};

const knowledgeResource: ResourceRef = {
  providerId: "agent-platform",
  resourceId: "knowledge-1",
  revision: "r4",
  resourceType: "knowledgeBase",
};

function provider(connectionId: string): ProviderConnectionProjection {
  return {
    connectionId,
    providerId: "agent-platform",
    kind: "agentPlatform",
    protocolVersion: "v1",
    status: "connected",
    capabilities: ["remoteAgent", "remoteTool", "remoteKnowledge"],
    resourceCapabilities: [
      {
        resourceType: "agent",
        mode: "providerManaged",
        executionLocation: "provider",
      },
      {
        resourceType: "skill",
        mode: "remoteReference",
        executionLocation: "provider",
      },
      {
        resourceType: "mcpTool",
        mode: "providerManaged",
        executionLocation: "provider",
      },
      {
        resourceType: "knowledgeBase",
        mode: "providerManaged",
        executionLocation: "provider",
      },
    ],
    projectionEtag: `etag-${connectionId}`,
    observedAt: 1n,
  };
}

function workspace(bindingId: string): WorkspaceRef {
  return {
    workspaceKey: "workspace-1",
    bindingId,
    scope: "conversation",
    scopeId: "thread-1",
    nodeId: "node-1",
    environmentId: "env-1",
  };
}

function binding(
  connectionId: string,
  bindingId: string,
): ResourceBindingProjection {
  return {
    connectionId,
    binding: {
      bindingId,
      workspaceKey: "workspace-1",
      resource: skillResource,
      mode: "remoteReference",
      executionLocation: "provider",
    },
    workspaceScope: "conversation",
    workspaceScopeId: "thread-1",
    status: "active",
    revision: 1n,
    updatedAt: 2n,
  };
}

function readyApi(overrides: Partial<ProviderResourceApi> = {}): ProviderResourceApi {
  return {
    async listWorkspaces(params) {
      if (params.cursor === null) {
        return {
          data: [
            {
              workspaceKey: "workspace-1",
              displayName: "cuican-aide",
              nodeId: "node-1",
              environmentId: "env-1",
              availability: "available",
            },
          ],
          nextCursor: "workspace-page-2",
          accessMode: "localProcessServerRoots",
        };
      }
      return {
        data: [],
        nextCursor: null,
        accessMode: "localProcessServerRoots",
      };
    },
    async bindWorkspace() {
      return { workspace: workspace("workspace-binding-1") };
    },
    async connectProvider() {
      return { provider: provider("connection-1") };
    },
    async readProvider(params) {
      return { provider: provider(params.connectionId) };
    },
    async listResources(params) {
      if (params.resourceType === "agent" && params.cursor === null) {
        return {
          data: [agentResource],
          nextCursor: "resource-page-2",
          providerEtag: `etag-${params.connectionId}`,
        };
      }
      if (params.resourceType === "agent") {
        return {
          data: [],
          nextCursor: null,
          providerEtag: `etag-${params.connectionId}`,
        };
      }
      return {
        data:
          params.resourceType === "skill"
            ? [skillResource]
            : params.resourceType === "mcpTool"
              ? [mcpToolResource]
              : params.resourceType === "knowledgeBase"
                ? [knowledgeResource]
                : [],
        nextCursor: null,
        providerEtag: `etag-${params.connectionId}`,
      };
    },
    async readResource(params) {
      return {
        manifest: {
          resource: params.resource,
          schemaVersion: "v1",
          contentDigest: null,
        },
        providerEtag: `etag-${params.connectionId}`,
      };
    },
    async bindResource(params) {
      return { binding: binding(params.connectionId, "resource-binding-1") };
    },
    async unbindResource() {
      return {
        bindingId: "resource-binding-1",
        status: "unbound",
        revision: 2n,
        updatedAt: 3n,
      };
    },
    ...overrides,
  };
}

describe("ProviderResourceSession", () => {
  it("loads bounded pages and binds an exact generated resource reference", async () => {
    const requests: unknown[] = [];
    const api = readyApi({
      async bindWorkspace(params) {
        requests.push(params);
        return { workspace: workspace("workspace-binding-1") };
      },
      async bindResource(params) {
        requests.push(params);
        return { binding: binding(params.connectionId, "resource-binding-1") };
      },
    });
    const session = new ProviderResourceSession(api);

    await session.refreshCatalog();
    await session.bind({
      workspaceKey: "workspace-1",
      scope: "conversation",
      scopeId: "thread-1",
      resource: skillResource,
      mode: "remoteReference",
    });

    expect(session.snapshot()).toMatchObject({
      phase: "bound",
      workspaces: [{ workspaceKey: "workspace-1" }],
      resources: [
        agentResource,
        skillResource,
        mcpToolResource,
        knowledgeResource,
      ],
      binding: { status: "active" },
    });
    const serialized = JSON.stringify(requests);
    for (const forbidden of [
      "actorId",
      "tenantId",
      "spaceId",
      "credential",
      "endpoint",
      "rootPath",
      "token",
      "secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("queries each advertised resource type instead of relying on the Provider default", async () => {
    const resourceTypes: Array<string | null | undefined> = [];
    const session = new ProviderResourceSession(
      readyApi({
        async listResources(params) {
          resourceTypes.push(params.resourceType);
          return {
            data: [],
            nextCursor: null,
            providerEtag: `etag-${params.connectionId}`,
          };
        },
      }),
    );

    await session.refreshCatalog();

    expect(resourceTypes).toEqual([
      "agent",
      "skill",
      "mcpTool",
      "knowledgeBase",
    ]);
  });

  it("rejects resources returned under a different requested type", async () => {
    const session = new ProviderResourceSession(
      readyApi({
        async listResources(params) {
          return {
            data: [skillResource],
            nextCursor: null,
            providerEtag: `etag-${params.connectionId}`,
          };
        },
      }),
    );

    await expect(session.refreshCatalog()).rejects.toThrow("type changed");
    expect(session.snapshot()).toMatchObject({
      phase: "unavailable",
      provider: null,
      resources: [],
    });
  });

  it("does not use browser storage as Provider or Binding authority", async () => {
    const forbiddenStorage = new Proxy(
      {},
      {
        get() {
          throw new Error("browser storage must not be used");
        },
      },
    );
    vi.stubGlobal("localStorage", forbiddenStorage);
    vi.stubGlobal("sessionStorage", forbiddenStorage);
    try {
      const session = new ProviderResourceSession(readyApi());
      await session.refreshCatalog();
      await session.bind({
        workspaceKey: "workspace-1",
        scope: "conversation",
        scopeId: "thread-1",
        resource: skillResource,
        mode: "remoteReference",
      });
      expect(session.snapshot().phase).toBe("bound");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed when a provider repeats a pagination cursor", async () => {
    let calls = 0;
    const session = new ProviderResourceSession(
      readyApi({
        async listResources(params) {
          calls += 1;
          return {
            data: [skillResource],
            nextCursor: "same-cursor",
            providerEtag: `etag-${params.connectionId}`,
          };
        },
      }),
    );

    await expect(session.refreshCatalog()).rejects.toThrow(
      "pagination cursor repeated",
    );
    expect(session.snapshot()).toMatchObject({
      phase: "unavailable",
      provider: null,
      binding: null,
    });
    expect(calls).toBe(4);
  });

  it("restarts once and then fails closed when the provider etag changes", async () => {
    let calls = 0;
    const session = new ProviderResourceSession(
      readyApi({
        async listResources() {
          calls += 1;
          return {
            data: [skillResource],
            nextCursor: null,
            providerEtag: "changed-etag",
          };
        },
      }),
    );

    await expect(session.refreshCatalog()).rejects.toThrow("etag changed");
    expect(calls).toBe(2);
    expect(session.snapshot()).toMatchObject({
      phase: "unavailable",
      error: "云端资源列表响应异常，请重试。",
    });
  });

  it("reconnects and rebinds the current page intent with fresh server ids", async () => {
    let generation = 1;
    const api = readyApi({
      async connectProvider() {
        return { provider: provider(`connection-${generation}`) };
      },
      async bindWorkspace() {
        return { workspace: workspace(`workspace-binding-${generation}`) };
      },
      async bindResource(params) {
        return {
          binding: binding(
            params.connectionId,
            `resource-binding-${generation}`,
          ),
        };
      },
    });
    const session = new ProviderResourceSession(api);
    await session.refreshCatalog();
    await session.bind({
      workspaceKey: "workspace-1",
      scope: "conversation",
      scopeId: "thread-1",
      resource: skillResource,
      mode: "remoteReference",
    });

    session.markDisconnected();
    generation = 2;
    await session.recover();

    expect(session.snapshot()).toMatchObject({
      phase: "bound",
      provider: { connectionId: "connection-2" },
      workspace: { bindingId: "workspace-binding-2" },
      binding: {
        connectionId: "connection-2",
        binding: { bindingId: "resource-binding-2" },
      },
    });
  });

  it("does not let a pre-disconnect response overwrite a newer generation", async () => {
    let resolveProvider!: (value: {
      provider: ProviderConnectionProjection;
    }) => void;
    const session = new ProviderResourceSession(
      readyApi({
        connectProvider: () =>
          new Promise((resolve) => {
            resolveProvider = resolve;
          }),
      }),
    );

    const refresh = session.refreshCatalog();
    session.markDisconnected();
    resolveProvider({ provider: provider("stale-connection") });
    await refresh;

    expect(session.snapshot()).toMatchObject({
      phase: "disconnected",
      provider: null,
      binding: null,
    });
  });

  it("clears authority projections when access is revoked", async () => {
    const session = new ProviderResourceSession(
      readyApi({
        async connectProvider() {
          throw new Error("Provider connection is not authorized");
        },
      }),
    );

    await expect(session.refreshCatalog()).rejects.toThrow("not authorized");
    expect(session.snapshot()).toMatchObject({
      phase: "unavailable",
      provider: null,
      workspace: null,
      binding: null,
      error: "云端资源授权不可用，请重新登录后重试。",
    });
  });

  it("accepts only monotonic notifications for the active binding", async () => {
    const session = new ProviderResourceSession(readyApi());
    await session.refreshCatalog();
    await session.bind({
      workspaceKey: "workspace-1",
      scope: "conversation",
      scopeId: "thread-1",
      resource: skillResource,
      mode: "remoteReference",
    });

    expect(
      session.applyBindingNotification({
        binding: binding("connection-1", "unknown-binding"),
      }),
    ).toBe("reconcileRequired");
    expect(
      session.applyBindingNotification({
        binding: binding("connection-1", "resource-binding-1"),
      }),
    ).toBe("ignored");

    expect(
      session.applyBindingNotification({
        binding: {
          ...binding("connection-1", "resource-binding-1"),
          status: "unbound",
          revision: 2n,
          updatedAt: 3n,
        },
      }),
    ).toBe("applied");
    expect(session.snapshot()).toMatchObject({ phase: "ready", binding: null });

    expect(
      session.applyBindingNotification({
        binding: binding("connection-1", "unknown-binding"),
      }),
    ).toBe("ignored");
  });
});
