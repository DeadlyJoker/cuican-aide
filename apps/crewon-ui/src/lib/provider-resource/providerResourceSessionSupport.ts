import type { ProviderConnectionProjection } from "@crewon-platform-protocol/v2/ProviderConnectionProjection";
import type { ResourceBindResponse } from "@crewon-platform-protocol/v2/ResourceBindResponse";
import type { ResourceBindingMode } from "@crewon-platform-protocol/v2/ResourceBindingMode";
import type { ExecutionLocation } from "@crewon-platform-protocol/v2/ExecutionLocation";
import type { ResourceRef } from "@crewon-platform-protocol/v2/ResourceRef";
import type { WorkspaceRef } from "@crewon-platform-protocol/v2/WorkspaceRef";
import type { WorkspaceScope } from "@crewon-platform-protocol/v2/WorkspaceScope";

const MAX_PAGES = 20;
const MAX_ITEMS = 1_000;

type CursorPage<Item> = {
  data: Item[];
  nextCursor: string | null;
};

export class ProviderResourcePaginationError extends Error {}

export async function collectPagesWithSingleRestart<
  Item,
  Page extends CursorPage<Item>,
>(
  load: (cursor: string | null) => Promise<Page>,
  generation: number,
  isCurrent: () => boolean,
  validatePage?: (page: Page) => void,
): Promise<Item[]> {
  try {
    return await collectPages(load, generation, isCurrent, validatePage);
  } catch (error) {
    if (!(error instanceof ProviderResourcePaginationError) || !isCurrent()) {
      throw error;
    }
    return collectPages(load, generation, isCurrent, validatePage);
  }
}

async function collectPages<Item, Page extends CursorPage<Item>>(
  load: (cursor: string | null) => Promise<Page>,
  generation: number,
  isCurrent: () => boolean,
  validatePage?: (page: Page) => void,
): Promise<Item[]> {
  const items: Item[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await load(cursor);
    if (!isCurrent()) {
      return [];
    }
    validatePage?.(response);
    if (!Array.isArray(response.data)) {
      throw new ProviderResourcePaginationError(
        "Provider resource pagination response is invalid",
      );
    }
    items.push(...response.data);
    if (items.length > MAX_ITEMS) {
      throw new ProviderResourcePaginationError(
        "Provider resource pagination item limit exceeded",
      );
    }
    const next = response.nextCursor;
    if (next === null) {
      return items;
    }
    if (typeof next !== "string" || !next || seenCursors.has(next)) {
      throw new ProviderResourcePaginationError(
        "Provider resource pagination cursor repeated",
      );
    }
    seenCursors.add(next);
    cursor = next;
  }

  throw new ProviderResourcePaginationError(
    `Provider resource pagination page limit exceeded for generation ${generation}`,
  );
}

export function assertProvider(
  provider: ProviderConnectionProjection,
  providerId: string,
): void {
  if (
    !provider.connectionId ||
    provider.providerId !== providerId ||
    !provider.protocolVersion ||
    !Array.isArray(provider.capabilities) ||
    !Array.isArray(provider.resourceCapabilities)
  ) {
    throw new Error("Provider connection response is invalid");
  }
}

export function assertResource(resource: ResourceRef, providerId: string): void {
  if (
    resource.providerId !== providerId ||
    !resource.resourceId ||
    !resource.revision
  ) {
    throw new Error("Provider resource response is invalid");
  }
}

export function assertWorkspace(
  workspace: WorkspaceRef,
  expected: {
    workspaceKey: string;
    scope: WorkspaceScope;
    scopeId: string;
  },
): void {
  if (
    workspace.workspaceKey !== expected.workspaceKey ||
    workspace.scope !== expected.scope ||
    workspace.scopeId !== expected.scopeId ||
    !workspace.bindingId
  ) {
    throw new Error("Workspace bind response is invalid");
  }
}

export function assertBinding(
  response: ResourceBindResponse,
  connectionId: string,
  workspace: WorkspaceRef,
  expected: {
    resource: ResourceRef;
    mode: ResourceBindingMode;
    executionLocation: ExecutionLocation;
  },
): void {
  const binding = response.binding;
  if (
    binding.connectionId !== connectionId ||
    binding.binding.workspaceKey !== workspace.workspaceKey ||
    binding.workspaceScope !== workspace.scope ||
    binding.workspaceScopeId !== workspace.scopeId ||
    binding.binding.mode !== expected.mode ||
    binding.binding.executionLocation !== expected.executionLocation ||
    binding.status !== "active" ||
    wireInteger(binding.revision) < 1n ||
    !sameResource(binding.binding.resource, expected.resource)
  ) {
    throw new Error("Provider resource bind response is invalid");
  }
}

export function sameResource(left: ResourceRef, right: ResourceRef): boolean {
  return (
    left.providerId === right.providerId &&
    left.resourceId === right.resourceId &&
    left.revision === right.revision &&
    left.resourceType === right.resourceType
  );
}

export function wireInteger(value: bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

export function providerResourceUserMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("not authorized")) {
    return "云端资源授权不可用，请重新登录后重试。";
  }
  if (message.includes("pagination")) {
    return "云端资源列表响应异常，请重试。";
  }
  if (message.includes("unavailable")) {
    return "云端资源服务暂不可用。";
  }
  if (message.includes("incompatible")) {
    return "当前资源不支持所选绑定方式。";
  }
  return "无法读取云端资源，请稍后重试。";
}
