import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProviderResourceSnapshot } from "../../lib/provider-resource/providerResourceSession";
import {
  ProviderResourcePicker,
  providerResourceComposerTag,
} from "./ProviderResourcePicker";

const readySnapshot: ProviderResourceSnapshot = {
  generation: 1,
  phase: "bound",
  workspaces: [
    {
      workspaceKey: "workspace-1",
      displayName: "cuican-aide",
      nodeId: "node-1",
      environmentId: "env-1",
      availability: "available",
    },
  ],
  provider: {
    connectionId: "connection-1",
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
        resourceType: "mcpServer",
        mode: "remoteReference",
        executionLocation: "provider",
      },
      {
        resourceType: "knowledgeBase",
        mode: "remoteReference",
        executionLocation: "provider",
      },
    ],
    projectionEtag: "etag-1",
    observedAt: 1n,
  },
  resources: [
    {
      providerId: "agent-platform",
      resourceId: "review-agent",
      revision: "agent-r1",
      resourceType: "agent",
    },
    {
      providerId: "agent-platform",
      resourceId: "code-review",
      revision: "skill-r2",
      resourceType: "skill",
    },
    {
      providerId: "agent-platform",
      resourceId: "github",
      revision: "mcp-r3",
      resourceType: "mcpServer",
    },
    {
      providerId: "agent-platform",
      resourceId: "product-docs",
      revision: "kb-r4",
      resourceType: "knowledgeBase",
    },
  ],
  workspace: {
    workspaceKey: "workspace-1",
    bindingId: "workspace-binding-1",
    scope: "conversation",
    scopeId: "thread-1",
    nodeId: "node-1",
    environmentId: "env-1",
  },
  binding: {
    connectionId: "connection-1",
    binding: {
      bindingId: "resource-binding-1",
      workspaceKey: "workspace-1",
      resource: {
        providerId: "agent-platform",
        resourceId: "code-review",
        revision: "skill-r2",
        resourceType: "skill",
      },
      mode: "remoteReference",
      executionLocation: "provider",
    },
    workspaceScope: "conversation",
    workspaceScopeId: "thread-1",
    status: "active",
    revision: 1n,
    updatedAt: 2n,
  },
  error: null,
};

describe("ProviderResourcePicker", () => {
  it("snapshots a compact real-resource list and active binding", () => {
    const markup = renderToStaticMarkup(
      <ProviderResourcePicker
        snapshot={readySnapshot}
        selectedResource={readySnapshot.resources[1] ?? null}
        onSelect={vi.fn()}
        onBind={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );

    expect(markup).toMatchSnapshot();
  });

  it("snapshots unavailable and recovering states without fake resources", () => {
    const unavailable = renderToStaticMarkup(
      <ProviderResourcePicker
        snapshot={{
          ...readySnapshot,
          phase: "unavailable",
          provider: null,
          resources: [],
          workspace: null,
          binding: null,
          error: "Provider connection is unavailable",
        }}
        selectedResource={null}
        onRetry={vi.fn()}
      />,
    );
    const recovering = renderToStaticMarkup(
      <ProviderResourcePicker
        snapshot={{
          ...readySnapshot,
          phase: "recovering",
          provider: null,
          resources: [],
          workspace: null,
          binding: null,
        }}
        selectedResource={null}
      />,
    );

    expect({ unavailable, recovering }).toMatchSnapshot();
  });

  it("snapshots a real resource whose binding capability is unavailable", () => {
    const resource = readySnapshot.resources[3] ?? null;
    const markup = renderToStaticMarkup(
      <ProviderResourcePicker
        snapshot={{
          ...readySnapshot,
          phase: "ready",
          provider: readySnapshot.provider
            ? {
                ...readySnapshot.provider,
                resourceCapabilities: [
                  {
                    resourceType: "knowledgeBase",
                    mode: "remoteReference",
                    executionLocation: "localNode",
                  },
                ],
              }
            : null,
          resources: resource ? [resource] : [],
          workspace: null,
          binding: null,
        }}
        selectedResource={resource}
        onBind={vi.fn()}
      />,
    );

    expect(markup).toMatchSnapshot();
  });

  it("maps only Skill, MCP and Knowledge resources to one composer tag", () => {
    const tags = readySnapshot.resources.map((resource) =>
      providerResourceComposerTag(resource, readySnapshot.binding),
    );

    expect(tags).toEqual([
      null,
      {
        id: "resource-binding-1",
        kind: "skill",
        label: "Skill",
        name: "code-review",
      },
      {
        id: "agent-platform:mcpServer:github:mcp-r3",
        kind: "mcp",
        label: "MCP",
        name: "github",
      },
      {
        id: "agent-platform:knowledgeBase:product-docs:kb-r4",
        kind: "knowledge",
        label: "知识库",
        name: "product-docs",
      },
    ]);
    expect(JSON.stringify(tags)).not.toContain("$code-review");
    expect(JSON.stringify(tags)).not.toContain("\n");
  });
});
