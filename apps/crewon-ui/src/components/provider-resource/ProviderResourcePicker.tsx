import {
  BookOpen,
  Bot,
  Cloud,
  GitBranch,
  Plug,
  RefreshCw,
  Sparkles,
  Unlink,
} from "lucide-react";

import type { ResourceBindingProjection } from "@crewon-platform-protocol/v2/ResourceBindingProjection";
import type { ResourceRef } from "@crewon-platform-protocol/v2/ResourceRef";
import type { ResourceType } from "@crewon-platform-protocol/v2/ResourceType";

import type { ComposerResourceTag } from "../composer/ComposerResourceTags";
import type { ProviderResourceSnapshot } from "../../lib/provider-resource/providerResourceSession";

import "./ProviderResourcePicker.css";

const resourcePresentation = {
  agent: { label: "智能体", icon: Bot },
  skill: { label: "Skill", icon: Sparkles },
  mcpServer: { label: "MCP", icon: Plug },
  mcpTool: { label: "MCP Tool", icon: Plug },
  knowledgeBase: { label: "知识库", icon: BookOpen },
  workflow: { label: "工作流", icon: GitBranch },
} satisfies Record<ResourceType, { label: string; icon: typeof Bot }>;

export function ProviderResourcePicker({
  snapshot,
  selectedResource,
  onSelect,
  onBind,
  onUnbind,
  onRetry,
  selectedWorkspaceKey,
  onWorkspaceSelect,
}: {
  snapshot: ProviderResourceSnapshot;
  selectedResource: ResourceRef | null;
  onSelect?: (resource: ResourceRef) => void;
  onBind?: (resource: ResourceRef) => void;
  onUnbind?: (binding: ResourceBindingProjection) => void;
  onRetry?: () => void;
  selectedWorkspaceKey?: string | null;
  onWorkspaceSelect?: (workspaceKey: string) => void;
}) {
  const isLoading =
    snapshot.phase === "loading" || snapshot.phase === "recovering";
  const activeBinding =
    snapshot.binding?.status === "active" ? snapshot.binding : null;
  const selectedBinding =
    activeBinding &&
    selectedResource &&
    sameResource(activeBinding.binding.resource, selectedResource)
      ? activeBinding
      : null;
  const selectedSupported =
    selectedResource !== null && resourceIsBindable(snapshot, selectedResource);

  return (
    <section
      className="provider-resource-picker"
      data-phase={snapshot.phase}
      aria-label="Provider 资源"
    >
      <header className="provider-resource-picker__header">
        <span className="provider-resource-picker__identity">
          <span className="provider-resource-picker__icon" aria-hidden="true">
            <Cloud />
          </span>
          <span>
            <strong>云端资源</strong>
            <small>{providerSummary(snapshot)}</small>
          </span>
        </span>
        {snapshot.provider && snapshot.workspaces.length > 0 ? (
          <label className="provider-resource-picker__workspace">
            <span className="visually-hidden">Provider 工作空间</span>
            <select
              aria-label="Provider 工作空间"
              value={selectedWorkspaceKey ?? ""}
              onChange={(event) => onWorkspaceSelect?.(event.target.value)}
            >
              {snapshot.workspaces.map((workspace) => (
                <option
                  disabled={workspace.availability !== "available"}
                  key={workspace.workspaceKey}
                  value={workspace.workspaceKey}
                >
                  {workspace.displayName}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span
          className="provider-resource-picker__status"
          data-status={providerStatus(snapshot)}
        >
          <i aria-hidden="true" />
          {statusLabel(snapshot)}
        </span>
      </header>

      {isLoading ? (
        <div className="provider-resource-picker__empty" role="status">
          <RefreshCw className="provider-resource-picker__spin" aria-hidden="true" />
          <strong>{snapshot.phase === "recovering" ? "正在恢复连接" : "正在读取资源"}</strong>
          <span>通过 app-server 校验身份、工作空间与 Provider 能力…</span>
        </div>
      ) : snapshot.phase === "unavailable" || snapshot.phase === "disconnected" ? (
        <div className="provider-resource-picker__empty" role="status">
          <Cloud aria-hidden="true" />
          <strong>
            {snapshot.phase === "disconnected" ? "连接已断开" : "云端资源暂不可用"}
          </strong>
          <span>{snapshot.error ?? "等待 app-server 恢复后重新读取真实状态。"}</span>
          {onRetry ? (
            <button type="button" onClick={onRetry}>
              <RefreshCw aria-hidden="true" />
              重试
            </button>
          ) : null}
        </div>
      ) : snapshot.resources.length === 0 ? (
        <div className="provider-resource-picker__empty" role="status">
          <Cloud aria-hidden="true" />
          <strong>暂无可用资源</strong>
          <span>Provider 已连接，但当前账号没有返回可绑定资源。</span>
        </div>
      ) : (
        <div className="provider-resource-picker__list" role="listbox">
          {snapshot.resources.map((resource) => {
            const presentation = resourcePresentation[resource.resourceType];
            const Icon = presentation.icon;
            const selected =
              selectedResource !== null && sameResource(resource, selectedResource);
            const bound =
              activeBinding !== null &&
              sameResource(activeBinding.binding.resource, resource);
            const bindable = resourceIsBindable(snapshot, resource);
            return (
              <button
                className="provider-resource-picker__item"
                data-bound={bound || undefined}
                data-selected={selected || undefined}
                key={resourceKey(resource)}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect?.(resource)}
              >
                <span className="provider-resource-picker__item-icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="provider-resource-picker__item-copy">
                  <strong>{resource.resourceId}</strong>
                  <small>
                    {presentation.label} · revision {resource.revision}
                  </small>
                </span>
                {bound ? <em>已绑定</em> : !bindable ? <em>不可绑定</em> : null}
              </button>
            );
          })}
        </div>
      )}

      {selectedResource && !isLoading ? (
        <footer className="provider-resource-picker__footer">
          <span>
            已选择 <strong>{selectedResource.resourceId}</strong>
          </span>
          {selectedBinding ? (
            <button type="button" onClick={() => onUnbind?.(selectedBinding)}>
              <Unlink aria-hidden="true" />
              解除绑定
            </button>
          ) : (
            <button
              type="button"
              disabled={
                snapshot.phase !== "ready" || !selectedSupported || !onBind
              }
              onClick={() => onBind?.(selectedResource)}
            >
              添加到会话
            </button>
          )}
        </footer>
      ) : null}
    </section>
  );
}

export function ProviderResourceComposerPopover({
  open,
  ...pickerProps
}: Parameters<typeof ProviderResourcePicker>[0] & { open: boolean }) {
  return (
    <div
      className="provider-resource-composer-popover"
      data-composer-palette="provider"
      hidden={!open}
    >
      <ProviderResourcePicker {...pickerProps} />
    </div>
  );
}

export function providerResourceComposerTag(
  resource: ResourceRef,
  binding: ResourceBindingProjection | null = null,
): ComposerResourceTag | null {
  const kind = composerKind(resource.resourceType);
  if (!kind) {
    return null;
  }
  const exactBinding =
    binding && sameResource(binding.binding.resource, resource) ? binding : null;
  return {
    id: exactBinding?.binding.bindingId ?? resourceKey(resource),
    kind,
    label: resourcePresentation[resource.resourceType].label,
    name: resource.resourceId,
  };
}

function composerKind(
  resourceType: ResourceType,
): "skill" | "mcp" | "knowledge" | null {
  switch (resourceType) {
    case "skill":
      return "skill";
    case "mcpServer":
    case "mcpTool":
      return "mcp";
    case "knowledgeBase":
      return "knowledge";
    case "agent":
    case "workflow":
      return null;
  }
}

function resourceKey(resource: ResourceRef): string {
  return [
    resource.providerId,
    resource.resourceType,
    resource.resourceId,
    resource.revision,
  ].join(":");
}

function sameResource(left: ResourceRef, right: ResourceRef): boolean {
  return resourceKey(left) === resourceKey(right);
}

function resourceIsBindable(
  snapshot: ProviderResourceSnapshot,
  resource: ResourceRef,
): boolean {
  return Boolean(
    snapshot.provider?.resourceCapabilities.some(
      (capability) =>
        capability.resourceType === resource.resourceType &&
        capability.executionLocation === "provider" &&
        (capability.mode === "remoteReference" ||
          capability.mode === "providerManaged"),
    ),
  );
}

function providerSummary(snapshot: ProviderResourceSnapshot): string {
  if (!snapshot.provider) {
    return "由 app-server 安全连接";
  }
  return `${snapshot.provider.providerId} · ${snapshot.resources.length} 项`;
}

function providerStatus(snapshot: ProviderResourceSnapshot): string {
  if (snapshot.phase === "unavailable" || snapshot.phase === "disconnected") {
    return "unavailable";
  }
  return snapshot.provider?.status ?? "pending";
}

function statusLabel(snapshot: ProviderResourceSnapshot): string {
  if (snapshot.phase === "recovering") {
    return "恢复中";
  }
  if (snapshot.phase === "loading") {
    return "连接中";
  }
  if (snapshot.phase === "disconnected") {
    return "已断开";
  }
  if (snapshot.phase === "unavailable") {
    return "不可用";
  }
  switch (snapshot.provider?.status) {
    case "connected":
      return "已连接";
    case "degraded":
      return "受限";
    case "disconnected":
      return "已断开";
    case undefined:
      return "等待连接";
  }
}
