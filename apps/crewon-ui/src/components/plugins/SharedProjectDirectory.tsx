import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Plus, RefreshCw, SquarePen } from "lucide-react";
import {
  createPluginCreativeProjectClient,
  type PluginUiDefinition,
  type PluginUiProps,
  type PluginUiServices,
} from "@crewon/plugin-sdk/ui";
import {
  createPluginProjectConversationsClient,
  parseProjectConversationsActionRequest,
  parseProjectConversationsActionResponse,
  type PublicProjectConversationBinding,
} from "@crewon/contracts/project-conversations";
import {
  PROJECT_CREATION_CONTEXT_ACTION,
  PROJECT_WORKSPACE_TARGET_ACTION,
  parseProjectCreationContextResponse,
  parseProjectWorkspaceTargetResponse,
} from "@crewon/contracts/project-workspace-target";
import { PLUGIN_UI_NAVIGATION_ACTIONS } from "@crewon/contracts/plugins";
import type { ControlApiClient } from "@crewon/control-client";
import { CommandWorkspaceDirectoryGroup } from "../app/CommandWorkspaceDirectoryGroup";
import { CommandSidebarThreadList } from "../app/CommandSidebarThreadList";
import type { CommandLinkedThread } from "../app/CommandWorkspaceChrome";
import { TooltipProvider } from "../ui/tooltip";

type Project = { projectId: string; title: string };
type Conversations = {
  threads: CommandLinkedThread[];
  next: string | null;
  bindings: readonly PublicProjectConversationBinding[];
};

/** A first-party presentation of the plugin's existing scoped services. */
export function sharedProjectDirectoryDefinition(input: {
  pluginId: string;
  contributionId: string;
  client: ControlApiClient;
}): PluginUiDefinition {
  return {
    apiVersion: "crewon.plugin-ui.v1",
    pluginId: input.pluginId,
    mount(element, props, services) {
      const root = createRoot(element);
      const render = (next: PluginUiProps) =>
        root.render(
          <TooltipProvider>
            <SharedProjectDirectory
              props={next}
              services={services}
              client={input.client}
              contributionId={input.contributionId}
            />
          </TooltipProvider>,
        );
      render(props);
      return { update: render, dispose: () => root.unmount() };
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function SharedProjectDirectory({
  props,
  services,
  client,
  contributionId,
}: {
  props: PluginUiProps;
  services: PluginUiServices;
  client: ControlApiClient;
  contributionId: string;
}) {
  const projectsApi = useMemo(
    () => createPluginCreativeProjectClient(services),
    [services],
  );
  const conversationsApi = useMemo(
    () =>
      createPluginProjectConversationsClient(services, {
        parseRequest: parseProjectConversationsActionRequest,
        parseResponse: parseProjectConversationsActionResponse,
      }),
    [services],
  );
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [conversations, setConversations] = useState<
    Record<string, Conversations>
  >({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const busy = loading || creating;
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Map<string, Promise<void>>());
  const projectReadEpoch = useRef(0);
  const creationKeys = useRef(new Map<string, string>());
  const lifetime = useMemo(() => new AbortController(), [services]);
  useEffect(() => () => lifetime.abort(), [lifetime]);
  const data = record(props.data);
  const presentation = record(data.hostPresentation);
  const projectId = record(presentation.context).projectId;
  const selectedThreadId = data.projectConversationAssociationThreadId;
  const locale = data.locale === "en" ? "en" : "zh";
  const report = () => {
    if (!lifetime.signal.aborted)
      setError(
        locale === "zh"
          ? "目录暂不可用，请重试。"
          : "Directory unavailable. Retry.",
      );
  };
  const openProject = async (project: Project) =>
    services.invoke(
      PLUGIN_UI_NAVIGATION_ACTIONS.openPage,
      {
        contributionId,
        key: `project:${project.projectId}`,
        title: project.title,
        mode: "reuse",
        context: { projectId: project.projectId, stage: "overview" },
      },
      { signal: lifetime.signal },
    );
  const loadProjects = async (after: string | null, signal: AbortSignal) => {
    const epoch = ++projectReadEpoch.current;
    setLoading(true);
    try {
      const result = await projectsApi.listProjects(
        {
          query: {
            state: archived ? "archived" : "active",
            limit: 50,
            ...(after ? { cursor: after } : {}),
          },
        },
        { signal },
      );
      if (signal.aborted || epoch !== projectReadEpoch.current) return;
      setProjects((previous) =>
        after
          ? [
              ...previous,
              ...result.projects.filter(
                (p) => !previous.some((v) => v.projectId === p.projectId),
              ),
            ]
          : result.projects,
      );
      setCursor(result.nextCursor);
      setError(null);
    } finally {
      if (!signal.aborted && epoch === projectReadEpoch.current)
        setLoading(false);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void loadProjects(null, controller.signal).catch(() => {
      if (!controller.signal.aborted) report();
    });
    return () => controller.abort();
  }, [projectsApi, archived, refresh, projectId]);
  const loadConversations = async (id: string, after: string | null = null) => {
    const existing = pending.current.get(id);
    if (existing) return existing;
    const work = Promise.resolve().then(async () => {
      try {
        const result = await conversationsApi.listConversations(
          { projectId: id, afterThreadId: after, limit: 16 },
          { signal: lifetime.signal },
        );
        const bindings = result.bindings.filter(
          (binding) => binding.state === "active",
        );
        const threads = await Promise.all(
          bindings.map(async (binding): Promise<CommandLinkedThread> => {
            const { thread } = await client.getThread(binding.threadId, {
              signal: lifetime.signal,
            });
            return {
              id: binding.threadId,
              title:
                thread.title || (locale === "zh" ? "项目会话" : "Conversation"),
              cwd: null,
              preview: "",
              updatedLabel: "",
            };
          }),
        );
        if (!lifetime.signal.aborted)
          setConversations((previous) => ({
            ...previous,
            [id]: {
              threads: after
                ? [...(previous[id]?.threads ?? []), ...threads]
                : threads,
              bindings: after
                ? [...(previous[id]?.bindings ?? []), ...bindings]
                : bindings,
              next: result.nextThreadId,
            },
          }));
      } finally {
        pending.current.delete(id);
      }
    });
    pending.current.set(id, work);
    return work;
  };
  useEffect(() => {
    if (typeof projectId === "string")
      void loadConversations(projectId).catch(report);
  }, [projectId, selectedThreadId, conversationsApi]);
  const openConversation = async (project: Project, threadId: string) => {
    await conversationsApi.openConversation(
      { projectId: project.projectId, threadId },
      { signal: lifetime.signal },
    );
    await openProject(project);
  };
  const newConversation = async (project: Project) => {
    setCreating(true);
    try {
      const mode = parseProjectCreationContextResponse(
        await services.invoke(
          PROJECT_CREATION_CONTEXT_ACTION,
          {},
          { signal: lifetime.signal },
        ),
      );
      const legacy = record(
        data.projectConversationContext,
      ).creationWorkspaceId;
      const workspaceId =
        mode.workspaceMode === "plugin-owned-explicit"
          ? parseProjectWorkspaceTargetResponse(
              await services.invoke(
                PROJECT_WORKSPACE_TARGET_ACTION,
                { projectId: project.projectId },
                { signal: lifetime.signal },
              ),
              { projectId: project.projectId },
            ).workspaceId
          : (conversations[project.projectId]?.bindings[0]?.workspaceId ??
            (typeof legacy === "string" ? legacy : null));
      const key =
        creationKeys.current.get(project.projectId) ??
        `project-directory:${crypto.randomUUID()}`;
      creationKeys.current.set(project.projectId, key);
      const result = await conversationsApi.createConversation(
        {
          projectId: project.projectId,
          workspaceId,
          title: locale === "zh" ? "项目会话" : "Conversation",
          idempotencyKey: key,
        },
        { signal: lifetime.signal },
      );
      await openConversation(project, result.binding.threadId);
      await pending.current.get(project.projectId);
      await loadConversations(project.projectId);
      creationKeys.current.delete(project.projectId);
    } finally {
      if (!lifetime.signal.aborted) setCreating(false);
    }
  };
  return (
    <section
      className="space-tree"
      aria-label={locale === "zh" ? "项目和会话" : "Projects and conversations"}
      data-shared-project-directory=""
    >
      <div className="tree-head">
        <strong className="tree-head-label">
          {locale === "zh" ? "项目" : "Projects"}
        </strong>
        <button
          className="tree-head-action"
          type="button"
          aria-label="刷新项目"
          disabled={busy}
          onClick={() => setRefresh((v) => v + 1)}
        >
          <RefreshCw aria-hidden="true" />
        </button>
        <button
          className="tree-head-action"
          type="button"
          aria-label="新建项目"
          onClick={() =>
            void services
              .invoke(
                PLUGIN_UI_NAVIGATION_ACTIONS.openPage,
                {
                  contributionId,
                  key: "home",
                  title: locale === "zh" ? "新建项目" : "New project",
                  mode: "reuse",
                  context: null,
                },
                { signal: lifetime.signal },
              )
              .catch(report)
          }
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
      {error ? (
        <p role="status" className="sidebar-empty-hint">
          {error}
        </p>
      ) : null}
      {!projects.length && !error ? (
        <p className="sidebar-empty-hint">{busy ? "正在读取…" : "暂无项目"}</p>
      ) : null}
      {projects.map((project) => {
        const list = conversations[project.projectId];
        return (
          <CommandWorkspaceDirectoryGroup
            key={project.projectId}
            id={`project-${project.projectId}`}
            name={project.title}
            current={project.projectId === projectId}
            initiallyCollapsed={project.projectId !== projectId}
            onExpand={() => {
              if (!list)
                void loadConversations(project.projectId).catch(report);
            }}
            onOpen={() => void openProject(project).catch(report)}
            actions={
              <button
                type="button"
                aria-label={`在 ${project.title} 中新建会话`}
                disabled={busy || archived}
                onClick={() => void newConversation(project).catch(report)}
              >
                <SquarePen aria-hidden="true" />
              </button>
            }
          >
            {list ? (
              <CommandSidebarThreadList
                threads={list.threads}
                selectedThreadId={
                  typeof selectedThreadId === "string" ? selectedThreadId : null
                }
                workspaceLabel={project.title}
                archiveLabel="归档会话"
                expanded={expanded.has(project.projectId)}
                onToggleExpanded={() =>
                  setExpanded((old) => {
                    const next = new Set(old);
                    if (next.has(project.projectId))
                      next.delete(project.projectId);
                    else next.add(project.projectId);
                    return next;
                  })
                }
                showMoreLabel={(count) => `展开更多（${count}）`}
                showFewerLabel="收起"
                onOpen={(id) =>
                  void openConversation(project, id).catch(report)
                }
              />
            ) : (
              <p className="sidebar-empty-hint">正在读取…</p>
            )}
            {list?.next ? (
              <button
                type="button"
                className="sidebar-threads-disclosure"
                onClick={() =>
                  void loadConversations(project.projectId, list.next).catch(
                    report,
                  )
                }
              >
                更多会话
              </button>
            ) : null}
          </CommandWorkspaceDirectoryGroup>
        );
      })}
      {cursor ? (
        <button
          className="sidebar-threads-disclosure"
          type="button"
          disabled={busy}
          onClick={() =>
            void loadProjects(cursor, lifetime.signal).catch(report)
          }
        >
          更多项目
        </button>
      ) : null}
      <button
        className="sidebar-threads-disclosure"
        type="button"
        disabled={busy}
        onClick={() => setArchived(!archived)}
      >
        {archived ? "返回进行中项目" : "已归档项目"}
      </button>
    </section>
  );
}
