import { useCallback, useEffect, useRef, useState } from "react";

import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ResourceBindingMode } from "@crewon/app-server-protocol/platform/v2/ResourceBindingMode";
import type { ResourceBindingUpdatedNotification } from "@crewon/app-server-protocol/platform/v2/ResourceBindingUpdatedNotification";
import type { ResourceRef } from "@crewon/app-server-protocol/platform/v2/ResourceRef";
import type { ThreadExecutionContext } from "@crewon/app-server-protocol/platform/v2/ThreadExecutionContext";

import type { AppServerClient } from "../app-server/appServer";
import type { ThreadExecutionContextPreparation } from "../thread/threadMessageActions";
import {
  ProviderResourceSession,
  type ProviderResourceSnapshot,
} from "./providerResourceSession";

const disconnectedSnapshot: ProviderResourceSnapshot = {
  generation: 0,
  phase: "disconnected",
  workspaces: [],
  provider: null,
  resources: [],
  workspace: null,
  binding: null,
  error: null,
};

export function useProviderResourceComposer({
  client,
  connectionAttempt,
  isConnected,
  selectedThreadId,
  onError,
}: {
  client: AppServerClient | null;
  connectionAttempt: number;
  isConnected: boolean;
  selectedThreadId: string | null;
  onError: (message: string) => void;
}) {
  const sessionRef = useRef<ProviderResourceSession | null>(null);
  const onErrorRef = useRef(onError);
  const activeContextRef = useRef<ThreadExecutionContext | null>(null);
  const [boundThreadId, setBoundThreadId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(disconnectedSnapshot);
  const [selectedResource, setSelectedResource] = useState<ResourceRef | null>(
    null,
  );
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<
    string | null
  >(null);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const refresh = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    try {
      const next = await session.refreshCatalog();
      setSelectedWorkspaceKey((current) =>
        next.workspaces.some((workspace) => workspace.workspaceKey === current)
          ? current
          : (next.workspaces.find(
              (workspace) => workspace.availability === "available",
            )?.workspaceKey ?? null),
      );
    } catch (error) {
      onErrorRef.current(
        error instanceof Error ? error.message : "Provider 资源暂不可用",
      );
    }
  }, []);

  useEffect(() => {
    if (!client || !isConnected) {
      sessionRef.current?.markDisconnected();
      sessionRef.current = null;
      activeContextRef.current = null;
      setBoundThreadId(null);
      setSelectedResource(null);
      setSnapshot(disconnectedSnapshot);
      return;
    }
    const session = new ProviderResourceSession(
      client.providerResources,
      setSnapshot,
    );
    sessionRef.current = session;
    void session
      .refreshCatalog()
      .then((next) => {
        setSelectedWorkspaceKey(
          next.workspaces.find(
            (workspace) => workspace.availability === "available",
          )?.workspaceKey ?? null,
        );
      })
      .catch(() => undefined);
    return () => {
      if (sessionRef.current === session) {
        session.markDisconnected();
        sessionRef.current = null;
      }
    };
  }, [client, connectionAttempt, isConnected, refresh]);

  const prepareThreadExecutionContext = useCallback(
    (): ThreadExecutionContextPreparation | null => {
      const session = sessionRef.current;
      const resource = selectedResource;
      const workspaceKey = selectedWorkspaceKey;
      const mode = bindingMode(snapshot, resource);
      if (!client || !session || !resource || !workspaceKey || !mode) {
        return null;
      }
      return {
        workspaceKey,
        afterStart: async (thread: Thread, context: ThreadExecutionContext) => {
          try {
            const bound = await session.bind({
              workspaceKey,
              scope: "conversation",
              scopeId: thread.id,
              resource,
              mode,
            });
            const workspace = bound.workspace;
            const binding = bound.binding;
            if (!workspace || !binding) {
              throw new Error("Provider resource binding was not created");
            }
            const updated = await client.providerResources.updateThreadExecutionContext({
              threadId: thread.id,
              workspaceBindingId: workspace.bindingId,
              resourceBindingIds: [binding.binding.bindingId],
              executionBindingId: executionBindingIdForResource(
                resource,
                binding.binding.bindingId,
              ),
              expectedRevision: Number(context.revision) as unknown as bigint,
            });
            activeContextRef.current = updated.executionContext;
            setBoundThreadId(thread.id);
          } catch (error) {
            await session.unbind().catch(() => undefined);
            throw error;
          }
        },
      };
    }, [client, selectedResource, selectedWorkspaceKey, snapshot]);

  const unbind = useCallback(async () => {
    const session = sessionRef.current;
    const context = activeContextRef.current;
    const binding = snapshot.binding;
    const workspace = snapshot.workspace;
    if (!client || !session || !context || !binding || !workspace) {
      return;
    }
    try {
      const updated = await client.providerResources.updateThreadExecutionContext({
        threadId: context.threadId,
        workspaceBindingId: workspace.bindingId,
        resourceBindingIds: [],
        executionBindingId: null,
        expectedRevision: Number(context.revision) as unknown as bigint,
      });
      activeContextRef.current = updated.executionContext;
      await session.unbind();
      activeContextRef.current = null;
      setBoundThreadId(null);
      setSelectedResource(null);
    } catch (error) {
      onErrorRef.current(
        error instanceof Error ? error.message : "解除 Provider 资源失败",
      );
    }
  }, [client, snapshot.binding, snapshot.workspace]);

  const handleBindingNotification = useCallback(
    (notification: ResourceBindingUpdatedNotification) => {
      const result = sessionRef.current?.applyBindingNotification(notification);
      if (result === "reconcileRequired") {
        void refresh();
      }
    },
    [refresh],
  );

  const bindingBelongsToSelectedThread =
    snapshot.binding !== null && boundThreadId === selectedThreadId;
  const commandShellSnapshot =
    snapshot.binding === null || bindingBelongsToSelectedThread
      ? snapshot
      : {
          ...snapshot,
          phase:
            snapshot.phase === "bound" ? ("ready" as const) : snapshot.phase,
          workspace: null,
          binding: null,
        };
  const supportedResources = providerConversationResources(
    commandShellSnapshot.resources,
  );
  const executionAgents = providerExecutionAgentResources(
    commandShellSnapshot.resources,
    commandShellSnapshot,
  );
  const supportedSelection =
    selectedResource && isConversationDynamicResource(selectedResource)
      ? selectedResource
      : null;
  const selectedExecutionAgent =
    selectedResource?.resourceType === "agent" ? selectedResource : null;
  const selectExecutionAgent = useCallback((resource: ResourceRef | null) => {
    setSelectedResource((current) =>
      resource ?? (current?.resourceType === "agent" ? null : current),
    );
  }, []);
  const commandShellResource =
    snapshot.phase === "disconnected"
      ? undefined
      : {
          snapshot: {
            ...commandShellSnapshot,
            resources: supportedResources,
          },
          selectedResource:
            snapshot.binding === null || bindingBelongsToSelectedThread
              ? supportedSelection
              : null,
          executionAgents,
          selectedExecutionAgent,
          selectedWorkspaceKey,
          canSelect: snapshot.binding === null || bindingBelongsToSelectedThread,
          onRefresh: refresh,
          onSelect: setSelectedResource,
          onExecutionAgentSelect: selectExecutionAgent,
          onUnbind: unbind,
          onWorkspaceSelect: setSelectedWorkspaceKey,
        };

  return {
    commandShellResource,
    handleBindingNotification,
    prepareThreadExecutionContext,
    refresh,
    selectedResource,
    selectedWorkspaceKey,
    setSelectedResource,
    setSelectedWorkspaceKey,
    snapshot,
    unbind,
  };
}

function bindingMode(
  snapshot: ProviderResourceSnapshot,
  resource: ResourceRef | null,
): ResourceBindingMode | null {
  if (!resource) {
    return null;
  }
  if (!isConversationBindableResource(resource)) {
    return null;
  }
  const capabilities = snapshot.provider?.resourceCapabilities.filter(
    (capability) =>
      capability.resourceType === resource.resourceType &&
      capability.executionLocation === "provider" &&
      (capability.mode === "remoteReference" ||
        capability.mode === "providerManaged"),
  );
  return (
    capabilities?.find(
      (capability) =>
        capability.mode ===
        (resource.resourceType === "agent"
          ? "providerManaged"
          : "remoteReference"),
    )?.mode ?? capabilities?.[0]?.mode ?? null
  );
}

function isConversationDynamicResource(resource: ResourceRef): boolean {
  return (
    resource.resourceType === "mcpTool" ||
    resource.resourceType === "knowledgeBase"
  );
}

function isConversationBindableResource(resource: ResourceRef): boolean {
  return (
    resource.resourceType === "agent" || isConversationDynamicResource(resource)
  );
}

export function providerConversationResources(
  resources: ResourceRef[],
): ResourceRef[] {
  return resources.filter(isConversationDynamicResource);
}

export function providerExecutionAgentResources(
  resources: ResourceRef[],
  snapshot: ProviderResourceSnapshot,
): ResourceRef[] {
  const supported = snapshot.provider?.resourceCapabilities.some(
    (capability) =>
      capability.resourceType === "agent" &&
      capability.mode === "providerManaged" &&
      capability.executionLocation === "provider",
  );
  return supported
    ? resources.filter((resource) => resource.resourceType === "agent")
    : [];
}

export function executionBindingIdForResource(
  resource: ResourceRef,
  bindingId: string,
): string | null {
  return resource.resourceType === "agent" ? bindingId : null;
}
