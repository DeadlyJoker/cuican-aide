import type { ControlApiClient } from "@crewon/control-client";
import type { PublicProjectConversationBinding } from "@crewon/contracts/project-conversations";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";

type Source = PublicProjectConversationBinding["source"];
export type ProjectWorkspaceChangeKind = "foundation" | "texts" | "assets";
type Listener = () => void;
const listeners = new WeakMap<ControlApiClient, Map<string, Set<Listener>>>();
const key = (
  projectId: string,
  source: Source,
  kind: ProjectWorkspaceChangeKind,
) =>
  JSON.stringify([
    projectId,
    kind,
    source.pluginId,
    source.publisherId,
    source.version,
    source.packageDigest,
    source.selectionRevision,
  ]);

/** A scoped read hint only. Saved content and permission still come from mount invokes. */
export function subscribeProjectWorkspaceChanges(
  client: ControlApiClient,
  projectId: string,
  module: ControlPluginUiModule,
  kind: ProjectWorkspaceChangeKind,
  listener: Listener,
): () => void {
  return subscribeProjectWorkspaceSourceChanges(
    client,
    projectId,
    {
      pluginId: module.plugin.descriptor.pluginId,
      publisherId: module.plugin.descriptor.publisherId,
      version: module.plugin.descriptor.version,
      packageDigest: module.plugin.packageDigest,
      selectionRevision: module.plugin.selectionRevision,
    },
    kind,
    listener,
  );
}

/** The authenticated conversation and mount share the same full source pin. */
export function subscribeProjectWorkspaceSourceChanges(
  client: ControlApiClient,
  projectId: string,
  source: Source,
  kind: ProjectWorkspaceChangeKind,
  listener: Listener,
): () => void {
  const identity = key(projectId, source, kind);
  const scopes = listeners.get(client) ?? new Map<string, Set<Listener>>();
  const group = scopes.get(identity) ?? new Set<Listener>();
  listeners.set(client, scopes);
  scopes.set(identity, group);
  group.add(listener);
  return () => {
    group.delete(listener);
    if (!group.size) scopes.delete(identity);
    if (!scopes.size) listeners.delete(client);
  };
}

export function notifyProjectWorkspaceChanged(
  client: ControlApiClient,
  projectId: string,
  source: Source,
  kind: ProjectWorkspaceChangeKind,
): void {
  for (const listener of [
    ...(listeners.get(client)?.get(key(projectId, source, kind)) ?? []),
  ]) {
    try {
      listener();
    } catch {
      // A read hint cannot turn an acknowledged write into a failed mutation,
      // or prevent another mounted consumer from refreshing.
    }
  }
}

/** Observe actual Run transitions; no timers, content projection or mutation replay. */
export function createProjectWorkspaceChangeObserver(client: ControlApiClient) {
  const lifetime = new AbortController();
  const runs = new Map<
    string,
    {
      seen: Set<string>;
      pending: Promise<void> | null;
      queued: Map<
        ProjectWorkspaceChangeKind | "terminal",
        { projectId?: string; toolName?: string }
      >;
    }
  >();
  function record(runId: string) {
    let run = runs.get(runId);
    if (!run) {
      if (runs.size >= 128) runs.delete(runs.keys().next().value!);
      run = { seen: new Set(), pending: null, queued: new Map() };
      runs.set(runId, run);
    }
    return run;
  }
  function refresh(
    threadId: string,
    runId: string,
    projectId?: string,
    toolName?: string,
  ) {
    if (lifetime.signal.aborted) return;
    const run = record(runId);
    const requestedKind =
      toolName === undefined
        ? null
        : operationKind(toolName.split("__").at(-1) ?? "");
    if (run.pending) {
      run.queued.set(requestedKind ?? "terminal", { projectId, toolName });
      return;
    }
    run.pending = (async () => {
      try {
        const { binding } = await client.projectConversations.getBinding(
          threadId,
          { signal: lifetime.signal },
        );
        if (
          lifetime.signal.aborted ||
          !binding ||
          binding.state !== "active" ||
          binding.threadId !== threadId ||
          (projectId !== undefined && binding.projectId !== projectId)
        )
          return;
        const prefix = `${binding.source.pluginId.replace(/[.-]/gu, "_")}__`;
        const operation = toolName?.startsWith(prefix)
          ? toolName.slice(prefix.length)
          : null;
        const kind = operation === null ? null : operationKind(operation);
        if (toolName !== undefined && kind === null) return;
        for (const area of kind
          ? [kind]
          : (["foundation", "texts", "assets"] as const)) {
          notifyProjectWorkspaceChanged(
            client,
            binding.projectId,
            binding.source,
            area,
          );
        }
      } catch {
        // Failure supplies neither a scope nor authority. A terminal observation
        // can make one further bounded read after a failed tool-time hint.
      } finally {
        run.pending = null;
        const next = run.queued.entries().next().value;
        if (next) {
          run.queued.delete(next[0]);
          refresh(threadId, runId, next[1].projectId, next[1].toolName);
        }
      }
    })();
  }
  return {
    tool(
      threadId: string,
      runId: string,
      item: Extract<ThreadItem, { type: "dynamicToolCall" }>,
    ) {
      const kind = operationKind(item.tool.split("__").at(-1) ?? "");
      if (!listeners.get(client)?.size || !kind) return;
      const run = record(runId);
      if (
        item.status !== "completed" ||
        item.success !== true ||
        item.arguments === null ||
        typeof item.arguments !== "object" ||
        Array.isArray(item.arguments) ||
        typeof item.arguments.projectId !== "string"
      )
        return;
      if (run.seen.has(`tool:${item.id}`) || run.seen.size >= 64) return;
      run.seen.add(`tool:${item.id}`);
      refresh(threadId, runId, item.arguments.projectId, item.tool);
    },
    terminal(threadId: string, runId: string) {
      if (!listeners.get(client)?.size || lifetime.signal.aborted) return;
      const run = record(runId);
      if (run.seen.has("terminal")) return;
      run.seen.add("terminal");
      refresh(threadId, runId);
    },
    close() {
      lifetime.abort();
      runs.clear();
    },
  };
}

function operationKind(operation: string): ProjectWorkspaceChangeKind | null {
  switch (operation) {
    case "foundation_proposal_save":
      return "foundation";
    case "outline_save":
    case "script_save":
    case "outline_change":
      return "texts";
    case "asset_save":
      return "assets";
    default:
      return null;
  }
}
