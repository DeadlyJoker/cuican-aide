import type { ProviderConnectionProjection } from "@crewon-platform-model/v2/ProviderConnectionProjection";
import type { ResourceBindingMode } from "@crewon-platform-model/v2/ResourceBindingMode";
import type { ResourceBindingProjection } from "@crewon-platform-model/v2/ResourceBindingProjection";
import type { ResourceBindingUpdatedNotification } from "@crewon-platform-model/v2/ResourceBindingUpdatedNotification";
import type { ResourceListParams } from "@crewon-platform-model/v2/ResourceListParams";
import type { ResourceListResponse } from "@crewon-platform-model/v2/ResourceListResponse";
import type { ResourceRef } from "@crewon-platform-model/v2/ResourceRef";
import type { ResourceType } from "@crewon-platform-model/v2/ResourceType";
import type { WorkspaceRef } from "@crewon-platform-model/v2/WorkspaceRef";
import type { WorkspaceScope } from "@crewon-platform-model/v2/WorkspaceScope";
import type { WorkspaceListResponse } from "@crewon-platform-model/v2/WorkspaceListResponse";
import type { WorkspaceSummary } from "@crewon-platform-model/v2/WorkspaceSummary";

import type { ProviderResourceClient } from "./providerResourceClient";
import {
  assertBinding,
  assertProvider,
  assertResource,
  assertWorkspace,
  collectPagesWithSingleRestart,
  ProviderResourcePaginationError,
  providerResourceUserMessage,
  sameResource,
  wireInteger,
} from "./providerResourceSessionSupport";

const DEFAULT_PROVIDER_ID = "agent-platform";
const PAGE_LIMIT = 100;

export type ProviderResourceApi = Pick<
  ProviderResourceClient,
  | "listWorkspaces"
  | "bindWorkspace"
  | "connectProvider"
  | "readProvider"
  | "listResources"
  | "readResource"
  | "bindResource"
  | "unbindResource"
>;

export type ProviderResourcePhase =
  | "idle"
  | "loading"
  | "ready"
  | "binding"
  | "bound"
  | "unbinding"
  | "recovering"
  | "disconnected"
  | "unavailable";

export type ProviderResourceBindingIntent = {
  workspaceKey: string;
  scope: WorkspaceScope;
  scopeId: string;
  resource: ResourceRef;
  mode: ResourceBindingMode;
};

export type ProviderResourceSnapshot = {
  generation: number;
  phase: ProviderResourcePhase;
  workspaces: WorkspaceSummary[];
  provider: ProviderConnectionProjection | null;
  resources: ResourceRef[];
  workspace: WorkspaceRef | null;
  binding: ResourceBindingProjection | null;
  error: string | null;
};

export type ProviderResourceNotificationResult =
  | "applied"
  | "ignored"
  | "reconcileRequired";

export class ProviderResourceSession {
  private generation = 0;
  private state: ProviderResourceSnapshot = {
    generation: 0,
    phase: "idle",
    workspaces: [],
    provider: null,
    resources: [],
    workspace: null,
    binding: null,
    error: null,
  };
  private intent: ProviderResourceBindingIntent | null = null;

  constructor(
    private readonly api: ProviderResourceApi,
    private readonly onChange?: (snapshot: ProviderResourceSnapshot) => void,
  ) {}

  snapshot(): ProviderResourceSnapshot {
    return {
      ...this.state,
      workspaces: [...this.state.workspaces],
      resources: [...this.state.resources],
    };
  }

  async refreshCatalog(resourceType: ResourceType | null = null) {
    const generation = this.begin("loading");
    try {
      await this.loadCatalog(generation, resourceType);
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.fail(error);
        throw error;
      }
    }
    return this.snapshot();
  }

  async bind(intent: ProviderResourceBindingIntent) {
    const generation = this.begin("binding", { clearAuthority: false });
    try {
      await this.bindWithGeneration(generation, intent);
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.fail(error);
        throw error;
      }
    }
    return this.snapshot();
  }

  async unbind() {
    const binding = this.state.binding;
    if (!binding) {
      return this.snapshot();
    }
    const generation = this.begin("unbinding", { clearAuthority: false });
    try {
      const response = await this.api.unbindResource({
        bindingId: binding.binding.bindingId,
      });
      if (!this.isCurrent(generation)) {
        return this.snapshot();
      }
      if (
        response.bindingId !== binding.binding.bindingId ||
        response.status !== "unbound" ||
        wireInteger(response.revision) <= wireInteger(binding.revision)
      ) {
        throw new Error("Provider resource unbind response is invalid");
      }
      this.intent = null;
      this.update({ phase: "ready", workspace: null, binding: null, error: null });
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.fail(error);
        throw error;
      }
    }
    return this.snapshot();
  }

  markDisconnected(): void {
    this.generation += 1;
    this.update({
      generation: this.generation,
      phase: "disconnected",
      provider: null,
      resources: [],
      workspace: null,
      binding: null,
      error: null,
    });
  }

  async recover(resourceType: ResourceType | null = null) {
    const generation = this.begin("recovering");
    const intent = this.intent;
    try {
      await this.loadCatalog(generation, resourceType);
      if (intent && this.isCurrent(generation)) {
        await this.bindWithGeneration(generation, intent);
      }
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.fail(error);
        throw error;
      }
    }
    return this.snapshot();
  }

  applyBindingNotification(
    notification: ResourceBindingUpdatedNotification,
  ): ProviderResourceNotificationResult {
    const current = this.state.binding;
    if (!current) {
      return "ignored";
    }
    const next = notification.binding;
    if (
      next.connectionId !== current.connectionId ||
      next.binding.bindingId !== current.binding.bindingId
    ) {
      return "reconcileRequired";
    }
    if (wireInteger(next.revision) <= wireInteger(current.revision)) {
      return "ignored";
    }
    if (next.status === "unbound") {
      this.intent = null;
      this.update({ phase: "ready", workspace: null, binding: null });
    } else {
      this.update({ phase: "bound", binding: next });
    }
    return "applied";
  }

  private async loadCatalog(
    generation: number,
    resourceType: ResourceType | null,
  ): Promise<void> {
    const providerResponse = await this.api.connectProvider({
      providerId: DEFAULT_PROVIDER_ID,
    });
    if (!this.isCurrent(generation)) {
      return;
    }
    assertProvider(providerResponse.provider, DEFAULT_PROVIDER_ID);

    const workspaces = await collectPagesWithSingleRestart<
      WorkspaceSummary,
      WorkspaceListResponse
    >(
      (cursor) => this.api.listWorkspaces({ cursor, limit: PAGE_LIMIT }),
      generation,
      () => this.isCurrent(generation),
    );
    const resourceTypes = resourceType
      ? [resourceType]
      : [
          ...new Set(
            providerResponse.provider.resourceCapabilities.map(
              (capability) => capability.resourceType,
            ),
          ),
        ];
    const resources: ResourceRef[] = [];
    const seenResources = new Set<string>();
    for (const requestedResourceType of resourceTypes) {
      const pageResources = await collectPagesWithSingleRestart<
        ResourceRef,
        ResourceListResponse
      >(
        (cursor) =>
          this.api.listResources({
            connectionId: providerResponse.provider.connectionId,
            cursor,
            limit: PAGE_LIMIT,
            resourceType: requestedResourceType,
          }),
        generation,
        () => this.isCurrent(generation),
        (page) => {
          if (page.providerEtag !== providerResponse.provider.projectionEtag) {
            throw new ProviderResourcePaginationError(
              "Provider resource pagination etag changed",
            );
          }
        },
      );
      if (!this.isCurrent(generation)) {
        return;
      }
      for (const resource of pageResources) {
        assertResource(resource, providerResponse.provider.providerId);
        if (resource.resourceType !== requestedResourceType) {
          throw new ProviderResourcePaginationError(
            "Provider resource pagination type changed",
          );
        }
        const key = [
          resource.providerId,
          resource.resourceType,
          resource.resourceId,
          resource.revision,
        ].join("\u0000");
        if (!seenResources.has(key)) {
          seenResources.add(key);
          resources.push(resource);
        }
      }
    }
    if (!this.isCurrent(generation)) {
      return;
    }
    this.update({
      phase: "ready",
      workspaces,
      provider: providerResponse.provider,
      resources,
      workspace: null,
      binding: null,
      error: null,
    });
  }

  private async bindWithGeneration(
    generation: number,
    intent: ProviderResourceBindingIntent,
  ): Promise<void> {
    const provider = this.state.provider;
    if (!provider) {
      throw new Error("Provider resource catalog is not ready");
    }
    const resource = this.state.resources.find((candidate) =>
      sameResource(candidate, intent.resource),
    );
    if (!resource) {
      throw new Error("Selected Provider resource is not in the current catalog");
    }
    const capability = provider.resourceCapabilities.find(
      (capability) =>
        capability.resourceType === resource.resourceType &&
        capability.mode === intent.mode,
    );
    if (!capability) {
      throw new Error("Selected Provider resource binding mode is incompatible");
    }
    const workspaceResponse = await this.api.bindWorkspace({
      workspaceKey: intent.workspaceKey,
      scope: intent.scope,
      scopeId: intent.scopeId,
    });
    if (!this.isCurrent(generation)) {
      return;
    }
    assertWorkspace(workspaceResponse.workspace, intent);

    const readResponse = await this.api.readResource({
      connectionId: provider.connectionId,
      resource,
    });
    if (!this.isCurrent(generation)) {
      return;
    }
    if (!sameResource(readResponse.manifest.resource, resource)) {
      throw new Error("Provider resource read returned a different revision");
    }
    if (readResponse.providerEtag !== provider.projectionEtag) {
      throw new Error("Provider resource authority changed during bind");
    }

    const bindResponse = await this.api.bindResource({
      connectionId: provider.connectionId,
      workspaceBindingId: workspaceResponse.workspace.bindingId,
      resource,
      mode: intent.mode,
    });
    if (!this.isCurrent(generation)) {
      return;
    }
    assertBinding(bindResponse, provider.connectionId, workspaceResponse.workspace, {
      ...intent,
      executionLocation: capability.executionLocation,
    });
    this.intent = { ...intent, resource };
    this.update({
      phase: "bound",
      workspace: workspaceResponse.workspace,
      binding: bindResponse.binding,
      error: null,
    });
  }

  private begin(
    phase: ProviderResourcePhase,
    options: { clearAuthority?: boolean } = {},
  ): number {
    this.generation += 1;
    const clearAuthority = options.clearAuthority ?? true;
    this.update({
      generation: this.generation,
      phase,
      error: null,
      ...(clearAuthority
        ? { provider: null, resources: [], workspace: null, binding: null }
        : {}),
    });
    return this.generation;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private fail(error: unknown): void {
    this.update({
      phase: "unavailable",
      provider: null,
      resources: [],
      workspace: null,
      binding: null,
      error: providerResourceUserMessage(error),
    });
  }

  private update(patch: Partial<ProviderResourceSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.onChange?.(this.snapshot());
  }
}
