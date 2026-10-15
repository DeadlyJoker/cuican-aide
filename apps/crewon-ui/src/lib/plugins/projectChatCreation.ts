import type { ControlApiClient } from "@crewon/control-client";
import {
  PROJECT_WORKSPACE_TARGET_ACTION,
  parseProjectWorkspaceTargetResponse,
} from "@crewon/contracts/project-workspace-target";
import {
  parseProjectFoundationUiRequest,
  parseProjectFoundationUiResponse,
} from "@crewon/contracts/project-foundation";
import {
  parseProjectConversationsActionRequest,
  parseProjectConversationsActionResponse,
  type PublicProjectConversationBinding,
} from "@crewon/contracts/project-conversations";
import {
  parsePluginUiJsonValue,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import { pluginUiControlRequest } from "./controlPluginUiSupport";

export type ProjectChatCreationInput = Readonly<{
  content: string;
  modelId?: string;
}>;
type Intent = {
  version: 1;
  key: string;
  content: string;
  modelId?: string;
  projectId: string | null;
  threadId: string | null;
  workspaceId: string | null;
  binding: PublicProjectConversationBinding | null;
  threadRevision: number | null;
  runId: string | null;
};
export type ProjectChatCreationPorts = Readonly<{
  client: ControlApiClient;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  ownerKey: string;
  assertCurrent(): void;
  acquire(
    module: ControlPluginUiModule,
    signal: AbortSignal,
  ): Promise<PluginUiLease>;
  release(lease: PluginUiLease): Promise<void>;
  adopt(
    receipt: Readonly<{ threadId: string; runId: string }>,
    signal: AbortSignal,
  ): Promise<void>;
  opened(
    module: ControlPluginUiModule,
    binding: PublicProjectConversationBinding,
  ): void;
  diagnostic(error: unknown): void;
}>;

/** User Send starts a project directly. Every write uses existing authenticated APIs and stable original keys. */
export function createProjectChatCreation(ports: ProjectChatCreationPorts) {
  const pending = new Map<
    string,
    { content: string; modelId: string | undefined; result: Promise<void> }
  >();
  const storageKeyFor = (module: ControlPluginUiModule) =>
    JSON.stringify([
      "crewon.project-chat-creation.v1",
      ports.ownerKey,
      module.mountKey,
    ]);
  const create = (
    module: ControlPluginUiModule,
    input: ProjectChatCreationInput,
  ): Promise<void> => {
    ports.assertCurrent();
    const storageKey = storageKeyFor(module);
    const content = input.content.trim();
    const modelId = input.modelId?.trim() || undefined;
    if (!content || new TextEncoder().encode(content).length > 8192)
      throw new Error("project_chat_prompt_limit");
    const active = pending.get(storageKey);
    if (active) {
      if (active.content !== content || active.modelId !== modelId)
        throw new Error("project_chat_original_request_pending");
      return active.result;
    }
    const run = async () => {
      ports.assertCurrent();
      const previous = ports.storage.getItem(storageKey);
      const intent =
        previous === null
          ? {
              version: 1 as const,
              key: crypto.randomUUID(),
              content,
              ...(modelId ? { modelId } : {}),
              projectId: null,
              threadId: null,
              workspaceId: null,
              binding: null,
              threadRevision: null,
              runId: null,
            }
          : readIntent(previous);
      if (intent.content !== content || intent.modelId !== modelId)
        throw new Error("project_chat_original_request_pending");
      const save = () =>
        ports.storage.setItem(storageKey, JSON.stringify(intent));
      save(); // Storage must succeed before the first dispatch, including after reload.
      const signal = new AbortController().signal;
      const lease = await ports.acquire(module, signal);
      const invoke = async (action: string, input: unknown) => {
        ports.assertCurrent();
        const response = await pluginUiControlRequest((s) =>
          ports.client.plugins.invoke(
            lease.mountRef,
            { action, input: parsePluginUiJsonValue(input) },
            { signal: s },
          ),
        );
        return response.output;
      };
      try {
        if (intent.projectId === null) {
          const request = parseProjectFoundationUiRequest({
            action: "crewon.project-foundation.v1.createProject",
            input: {
              title: [...content.split(/\r?\n/u)[0]!].slice(0, 32).join(""),
              briefText: content,
              origin: "creative",
              creativeStartMode: "confirm-plan",
              sourceUpload: null,
              parameters: {
                genre: null,
                episodeMode: "series",
                episodeCount: null,
                episodeDurationSeconds: null,
                aspectRatio: "16:9",
                visualStyle: null,
                needsCharacters: true,
                needsArt: true,
                adaptation: null,
              },
              idempotencyKey: `project-chat-create:${intent.key}`,
            },
          });
          const result = parseProjectFoundationUiResponse(
            await invoke(request.action, request.input),
            request,
          );
          if (!("project" in result) || !result.project)
            throw new Error("project_chat_creation_invalid");
          intent.projectId = result.project.projectId;
          save();
        }
        if (intent.binding === null) {
          if (intent.workspaceId === null) {
            const request = { projectId: intent.projectId! };
            const target = parseProjectWorkspaceTargetResponse(
              await invoke(PROJECT_WORKSPACE_TARGET_ACTION, request),
              request,
            );
            intent.workspaceId = target.workspaceId;
            save();
          }
          const request = parseProjectConversationsActionRequest({
            action: "crewon.project-conversations.v1.createConversation",
            input: {
              projectId: intent.projectId,
              workspaceId: intent.workspaceId,
              title: "创作对话",
              idempotencyKey: `project-chat-thread:${intent.key}`,
            },
          });
          const result = parseProjectConversationsActionResponse(
            request,
            await invoke(request.action, request.input),
          );
          if (!("binding" in result) || !result.binding)
            throw new Error("project_chat_binding_invalid");
          intent.binding = result.binding;
          intent.threadId = result.binding.threadId;
          save();
        }
        const source = intent.binding.source;
        if (
          source.pluginId !== lease.descriptor.pluginId ||
          source.publisherId !== lease.descriptor.publisherId ||
          source.version !== lease.descriptor.version ||
          source.packageDigest !== lease.packageDigest ||
          source.selectionRevision !== lease.selectionRevision ||
          intent.binding.projectId !== intent.projectId ||
          intent.binding.threadId !== intent.threadId ||
          intent.binding.workspaceId !== intent.workspaceId
        )
          throw new Error("project_chat_source_changed");
        ports.assertCurrent();
        if (intent.threadRevision === null) {
          const response = await pluginUiControlRequest((signal) =>
            ports.client.getThread(intent.threadId!, { signal }),
          );
          intent.threadRevision = response.thread.revision;
          save();
        }
        ports.assertCurrent();
        if (intent.runId === null) {
          const result = await pluginUiControlRequest((signal) =>
            ports.client.projectConversations.startStage(
              intent.threadId!,
              {
                projectId: intent.projectId!,
                threadId: intent.threadId!,
                expectedThreadRevision: intent.threadRevision!,
                expectedBindingRevision: intent.binding!.revision,
                content: intent.content,
                ...(intent.modelId ? { modelId: intent.modelId } : {}),
                idempotencyKey: `project-chat-first-turn:${intent.key}`,
                stage: { kind: "discussion" },
              },
              { signal },
            ),
          );
          intent.runId = result.runId;
          save();
        }
        ports.assertCurrent();
        await pluginUiControlRequest(
          (signal) =>
            ports.adopt(
              { threadId: intent.threadId!, runId: intent.runId! },
              signal,
            ),
          signal,
        );
        ports.assertCurrent();
        ports.opened(module, intent.binding);
        ports.storage.removeItem(storageKey);
      } finally {
        void ports.release(lease).catch(ports.diagnostic);
      }
    };
    const result = run().finally(() => pending.delete(storageKey));
    pending.set(storageKey, { content, modelId, result });
    return result;
  };
  return Object.assign(create, {
    pending(
      module: ControlPluginUiModule,
    ): ProjectChatCreationInput | undefined {
      ports.assertCurrent();
      try {
        const raw = ports.storage.getItem(storageKeyFor(module));
        if (raw === null) return undefined;
        const intent = readIntent(raw);
        return Object.freeze({
          content: intent.content,
          ...(intent.modelId ? { modelId: intent.modelId } : {}),
        });
      } catch (error) {
        ports.diagnostic(error);
        return undefined;
      }
    },
  });
}
function readIntent(raw: string): Intent {
  if (raw.length > 24000) throw new Error("project_chat_intent_invalid");
  const v = JSON.parse(raw) as Intent;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some(
      (key) =>
        ![
          "version",
          "key",
          "content",
          "modelId",
          "projectId",
          "threadId",
          "workspaceId",
          "binding",
          "threadRevision",
          "runId",
        ].includes(key),
    ) ||
    v.version !== 1 ||
    typeof v.key !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(v.key) ||
    typeof v.content !== "string" ||
    !v.content.trim() ||
    new TextEncoder().encode(v.content).length > 8192 ||
    (v.modelId !== undefined &&
      (typeof v.modelId !== "string" || v.modelId.length > 128))
  )
    throw new Error("project_chat_intent_invalid");
  for (const key of ["projectId", "threadId", "workspaceId", "runId"] as const)
    if (
      v[key] !== null &&
      (typeof v[key] !== "string" || v[key]!.length > 128 || !v[key])
    )
      throw new Error("project_chat_intent_invalid");
  if (
    v.threadRevision !== null &&
    (!Number.isSafeInteger(v.threadRevision) || v.threadRevision < 1)
  )
    throw new Error("project_chat_intent_invalid");
  if (v.binding !== null) {
    const request = parseProjectConversationsActionRequest({
      action: "crewon.project-conversations.v1.openConversation",
      input: { projectId: v.projectId, threadId: v.threadId },
    });
    const result = parseProjectConversationsActionResponse(request, {
      binding: v.binding,
    });
    if (!("binding" in result) || !result.binding)
      throw new Error("project_chat_intent_invalid");
    v.binding = result.binding;
  }
  return v;
}
