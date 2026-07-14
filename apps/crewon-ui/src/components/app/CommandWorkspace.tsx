import {
  ArrowUp,
  FileText,
  ImagePlus,
  ListChecks,
  Plus,
  ShieldCheck,
  Square,
  Target,
  X,
} from "lucide-react";
import type { Thread } from "@crewon-protocol/v2/Thread";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { officeRooms, workflowRooms } from "./commandWorkspaceData";
import {
  CommandSidebar,
  Palette,
  type CommandLinkedThread,
  type PaletteItemWithCommand,
} from "./CommandWorkspaceChrome";
import type { CommandWorkspaceClient } from "./CommandProjectTree";
import { CommandThreadRoom } from "./CommandWorkspaceConversation";
import { CommandSceneHeader } from "./CommandSceneHeader";
import {
  AgentsView,
  AssistView,
  KnowledgeCatalogView,
  ProjectsView,
  ScheduleView,
  TeamView,
} from "./CommandWorkspaceViews";
import { classNames } from "./commandWorkspaceUtils";
import {
  agentPlatformResourceCategories,
  agentPlatformResourceStates,
  emptyAgentPlatformSnapshot,
  insertTokenIntoComposerValue,
  mergeAgentPlatformSnapshot,
  selectCommandHomeSlots,
  setAgentPlatformResourceState,
  type AgentPlatformComposerResource,
  type CommandHomeSlots,
  type CommandShellView,
} from "./commandWorkspaceState";
import {
  commandSceneContextItems,
  commandSceneSlashItems,
  findCompatibleOnlineAgent,
} from "./commandWorkspaceSceneResources";
import {
  readAgentPlatformSnapshot,
  type AgentPlatformResourceCategory,
  type AgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";
import { buildPimDynamicTools } from "../../lib/agent-platform/pimDynamicTools";
import type { ComposerImageInput } from "../../lib/shared/composerImages";
import {
  attachmentContext,
  prepareComposerAttachments,
  type ComposerAttachment,
} from "../../lib/shared/composerAttachments";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { Locale } from "../../lib/i18n";
import type { ConnectionState } from "../../lib/shared/connectionState";
import { formatRelativeTime } from "../../lib/shared/text";
import {
  executionTargetOptionsFromDomain,
  scenePresets,
  type CommandScene,
  type SceneInteractionMode,
} from "../../lib/scene/sceneCatalog";
import type { AgentConfig, OfficeConfig } from "../../lib/domain/domainTypes";
import {
  agentPlatformTargetFromThreadSource,
  agentPlatformThreadSource,
  commandComposerRuntimeSettings,
  fallbackCommandModelOptions,
  type CommandComposerPermission,
  type CommandExecutionIntent,
  type CommandModelOption,
  type ThreadRuntimeSettings,
} from "../../lib/thread/threadRuntimeSettings";
import type { WorkMode } from "../../lib/workMode";
import { sidebarThreadTitle } from "../SidebarPresentation";

export {
  activateDesignPanelTab,
  applyDesignCardVisibility,
  cleanSlotTitle,
  insertTokenIntoComposerValue,
  selectCommandHomeSlots,
  setActiveFilter,
  setDefaultTeamOfficePreview,
  syncDesignFilterState,
} from "./commandWorkspaceState";

type CommandWorkspaceProps = {
  activeTurnId?: string | null;
  composerValue: string;
  connectionState: ConnectionState;
  cwd: string;
  executionTargetClient?: (CommandWorkspaceClient & {
    listAgentConfigs(cwd: string): Promise<{
      data: Array<{ config: AgentConfig; filePath: string }>;
    }>;
    listOfficeConfigs(cwd: string): Promise<{
      data: Array<{ config: OfficeConfig; filePath: string }>;
    }>;
  }) | null;
  isSending: boolean;
  linkedThreads?: Thread[];
  locale?: Locale;
  modelOptions?: CommandModelOption[];
  selectedThread?: Thread | null;
  selectedThreadId?: string | null;
  slashCommands?: ComposerSlashCommand[];
  streamingText?: string;
  workMode: WorkMode;
  onAttachContext: () => void;
  onChangeComposerValue: (value: string) => void;
  onChangeWorkspaceCwd?: (cwd: string | null) => void;
  onModeChange: (mode: WorkMode) => void;
  onRetryConnection: () => void;
  onSend: (
    text: string,
    threadSettings?: ThreadRuntimeSettings,
    images?: ComposerImageInput[],
  ) => void;
  onSendNewThread?: (
    text: string,
    threadSettings?: ThreadRuntimeSettings,
    workspaceCwd?: string | null,
    images?: ComposerImageInput[],
  ) => void;
  onSelectLinkedThread?: (threadId: string | null) => void;
  onSlashCommandSelect?: (command: ComposerSlashCommand) => void;
  onStop?: () => void;
};

type PlatformLoadState = "loading" | "ready" | "fallback";
type TeamMode = "office" | "workflow" | "experts";
export type CommandComposerKeyIntent =
  | "closePalette"
  | "openContext"
  | "openSlash"
  | "send"
  | null;
export type CommandComposerKeyIntentInput = {
  altKey: boolean;
  composerValue: string;
  ctrlKey: boolean;
  hasOpenPalette: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
};

const shellViewIds: CommandShellView[] = [
  "command",
  "assist",
  "projects",
  "agents",
  "knowledge",
  "schedule",
  "team",
];

type CommandSelectOption<TValue extends string = string> = {
  detail?: string;
  disabled?: boolean;
  tone?: "danger" | "normal" | "warning";
  value: TValue;
  label: string;
};

const permissionOptions: CommandSelectOption<CommandComposerPermission>[] = [
  {
    detail: "工作区内自动执行，必要时请求升级",
    label: "本地自动",
    value: "approve-for-me",
  },
  {
    detail: "涉及授权时先请求确认",
    label: "操作前确认",
    value: "request-approval",
  },
];

const noWorkspaceValue = "__no_workspace__";
const maxComposerImages = 2;
const maxComposerImageBytes = 5 * 1024 * 1024;
const supportedComposerImageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function isShellView(value: string): value is CommandShellView {
  return shellViewIds.includes(value as CommandShellView);
}

function shellViewFromHash(): CommandShellView {
  if (typeof window === "undefined") {
    return "command";
  }
  const value = window.location.hash.replace(/^#view-/, "");
  return isShellView(value) ? value : "command";
}

function imageDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取粘贴的图片。"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function CommandComposerSelect<TValue extends string>({
  ariaLabel,
  className,
  icon,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  className: string;
  icon?: ReactNode;
  options: CommandSelectOption<TValue>[];
  value: TValue;
  onChange: (value: TValue) => void;
}) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) {
      return;
    }
    function closeOnPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={classNames("control-select", className)}
      data-open={open ? "true" : "false"}
    >
      <span className="visually-hidden">{ariaLabel}</span>
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="select-trigger"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        {selectedOption?.label ?? value}
      </button>
      <div className="select-menu" hidden={!open} id={menuId} role="listbox">
        {options.map((option) => (
          <button
            key={option.value}
            aria-selected={option.value === value}
            className="select-option"
            data-tone={option.tone ?? "normal"}
            data-value={option.value}
            disabled={option.disabled}
            role="option"
            type="button"
            onClick={() => {
              if (option.disabled) {
                return;
              }
              onChange(option.value);
              setOpen(false);
            }}
          >
            <span>
              <strong>{option.label}</strong>
              {option.detail ? <em>{option.detail}</em> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

function compactSearchText(value: string) {
  return value.toLocaleLowerCase().replace(/[\s_\-./]+/g, "");
}

function isSubsequence(query: string, value: string) {
  let queryIndex = 0;
  for (const character of value) {
    if (character === query[queryIndex]) {
      queryIndex += 1;
    }
  }
  return queryIndex === query.length;
}

function fuzzyTermScore(term: string, value: string, weight: number) {
  const normalized = value.toLocaleLowerCase();
  if (normalized.includes(term)) {
    return weight * 2;
  }
  return normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map(compactSearchText)
    .some((word) => isSubsequence(term, word))
    ? weight
    : 0;
}

export function paletteFilter(items: PaletteItemWithCommand[], query: string) {
  const terms = query
    .trim()
    .split(/\s+/)
    .map(compactSearchText)
    .filter(Boolean);
  if (terms.length === 0) {
    return items;
  }

  return items
    .map((item) => {
      const fields = [
        { value: item.title, weight: 5 },
        { value: item.token, weight: 4 },
        { value: item.label, weight: 2 },
        { value: item.detail, weight: 1 },
      ];
      let score = 0;
      for (const term of terms) {
        const termScore = Math.max(
          ...fields.map(({ value, weight }) =>
            value ? fuzzyTermScore(term, value, weight) : 0,
          ),
        );
        if (termScore === 0) {
          return null;
        }
        score += termScore;
      }
      return { item, score };
    })
    .filter((candidate): candidate is { item: PaletteItemWithCommand; score: number } =>
      candidate !== null,
    )
    .sort((left, right) => right.score - left.score)
    .map((candidate) => candidate.item);
}

function platformResourcePrefix(resource: AgentPlatformComposerResource) {
  return resource.type === "knowledge_bases" ? "@" : "/";
}

function platformResourceToken(resource: AgentPlatformComposerResource) {
  return `${platformResourcePrefix(resource)}${resource.name}`;
}

function platformResourceLabel(resource: AgentPlatformComposerResource) {
  if (resource.type === "skills") return "Skill";
  if (resource.type === "mcp_servers") return "MCP";
  return "知识库";
}

function isPimExecutionTarget(value: string): boolean {
  return value.startsWith("agent-platform:agents:");
}

export function nextExecutionIntent(
  current: CommandExecutionIntent,
  selected: Exclude<CommandExecutionIntent, "none">,
): CommandExecutionIntent {
  return current === selected ? "none" : selected;
}

export function shouldCloseComposerPalette({
  paletteRoots,
  target,
  triggers,
}: {
  paletteRoots: Array<Pick<Node, "contains">>;
  target: Node | null;
  triggers: Array<Pick<Node, "contains">>;
}): boolean {
  if (!target) {
    return false;
  }
  return ![...paletteRoots, ...triggers].some((element) =>
    element.contains(target),
  );
}

export function commandComposerKeyIntent({
  altKey,
  composerValue,
  ctrlKey,
  hasOpenPalette,
  isComposing,
  key,
  metaKey,
  shiftKey,
}: CommandComposerKeyIntentInput): CommandComposerKeyIntent {
  if (isComposing) {
    return null;
  }

  if (key === "Escape" && hasOpenPalette) {
    return "closePalette";
  }

  if (key === "Enter") {
    if (hasOpenPalette) {
      return null;
    }
    if (metaKey || ctrlKey) {
      return "send";
    }
    if (!shiftKey && !altKey) {
      return "send";
    }
    return null;
  }

  if (!metaKey && !ctrlKey && !altKey) {
    if (key === "@") {
      return "openContext";
    }
    if (key === "/" && (!composerValue || /\s$/.test(composerValue))) {
      return "openSlash";
    }
  }

  return null;
}

export function CommandWorkspace({
  activeTurnId = null,
  composerValue,
  connectionState,
  cwd,
  executionTargetClient = null,
  isSending,
  linkedThreads = [],
  locale = "zh",
  modelOptions = fallbackCommandModelOptions,
  selectedThread = null,
  selectedThreadId = null,
  slashCommands = [],
  streamingText = "",
  workMode,
  onChangeComposerValue,
  onChangeWorkspaceCwd,
  onModeChange,
  onRetryConnection,
  onSend,
  onSendNewThread,
  onSelectLinkedThread,
  onSlashCommandSelect,
  onStop,
}: CommandWorkspaceProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeView, setActiveView] = useState<CommandShellView>(() =>
    shellViewFromHash(),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [activeLinkedThreadId, setActiveLinkedThreadId] = useState<
    string | null
  >(selectedThreadId);
  const [newTaskDraft, setNewTaskDraft] = useState(false);
  const [scene, setScene] = useState<CommandScene>("office");
  const [sceneMode, setSceneMode] = useState<SceneInteractionMode>("auto");
  const [model, setModel] = useState(fallbackCommandModelOptions[0].value);
  const [reasoningEffort, setReasoningEffort] = useState("medium");
  const [modelSelectionTouched, setModelSelectionTouched] = useState(false);
  const [executionTarget, setExecutionTarget] = useState("crewon");
  const [executionTargetCatalog, setExecutionTargetCatalog] = useState<{
    agents: Array<{ config: AgentConfig; filePath: string }>;
    offices: Array<{ config: OfficeConfig; filePath: string }>;
    status: "loading" | "ready" | "unavailable";
  }>({ agents: [], offices: [], status: "loading" });
  const [permission, setPermission] =
    useState<CommandComposerPermission>("approve-for-me");
  const [executionIntent, setExecutionIntent] =
    useState<CommandExecutionIntent>("none");
  const [openPalette, setOpenPalette] = useState<
    "add" | "context" | "slash" | null
  >(null);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [platformSnapshot, setPlatformSnapshot] =
    useState<AgentPlatformSnapshot>(emptyAgentPlatformSnapshot);
  const [selectedPlatformResources, setSelectedPlatformResources] = useState<
    AgentPlatformComposerResource[]
  >([]);
  const [composerImages, setComposerImages] = useState<ComposerImageInput[]>(
    [],
  );
  const [composerAttachments, setComposerAttachments] = useState<
    ComposerAttachment[]
  >([]);
  const [composerResourceError, setComposerResourceError] = useState<
    string | null
  >(null);
  const [catalogFilter, setCatalogFilter] = useState("skill");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [scheduleMode, setScheduleMode] = useState("calendar");
  const [scheduleSource, setScheduleSource] = useState("personal");
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [teamMode, setTeamMode] = useState<TeamMode>("office");
  const [officeRoomId, setOfficeRoomId] = useState<string | null>(null);
  const [workflowRoomId, setWorkflowRoomId] = useState<string | null>(null);
  const [officeTab, setOfficeTab] = useState("chat");
  const [workflowTab, setWorkflowTab] = useState("run");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function syncHash() {
      setActiveView(shellViewFromHash());
    }
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!executionTargetClient || !cwd) {
      setExecutionTargetCatalog({
        agents: [],
        offices: [],
        status: "unavailable",
      });
      return;
    }
    setExecutionTargetCatalog((current) => ({ ...current, status: "loading" }));
    Promise.all([
      executionTargetClient.listAgentConfigs(cwd),
      executionTargetClient.listOfficeConfigs(cwd),
    ])
      .then(([agents, offices]) => {
        if (!cancelled) {
          setExecutionTargetCatalog({
            agents: agents.data,
            offices: offices.data,
            status: "ready",
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExecutionTargetCatalog({
            agents: [],
            offices: [],
            status: "unavailable",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, executionTargetClient]);

  useEffect(() => {
    let cancelled = false;
    readAgentPlatformSnapshot()
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        setPlatformSnapshot((current) =>
          mergeAgentPlatformSnapshot(current, snapshot),
        );
      })
      .catch((reason) => {
        if (cancelled) {
          return;
        }
        const error =
          reason instanceof Error
            ? reason.message
            : "agent-platform unavailable";
        setPlatformSnapshot((current) =>
          setAgentPlatformResourceState(
            current,
            agentPlatformResourceCategories,
            { status: "error", error },
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setActiveLinkedThreadId(selectedThreadId);
  }, [selectedThreadId]);

  const effectiveModelOptions =
    modelOptions.length > 0 ? modelOptions : fallbackCommandModelOptions;

  useEffect(() => {
    const defaultModel = effectiveModelOptions.find(
      (option) => option.isDefault,
    )?.value;
    if (!effectiveModelOptions.some((option) => option.value === model)) {
      setModel(
        defaultModel ??
          effectiveModelOptions[0]?.value ??
          fallbackCommandModelOptions[0].value,
      );
      return;
    }
    if (!modelSelectionTouched && defaultModel && model !== defaultModel) {
      setModel(defaultModel);
    }
  }, [effectiveModelOptions, model, modelSelectionTouched]);

  const slots = useMemo(
    () => selectCommandHomeSlots(platformSnapshot),
    [platformSnapshot],
  );
  const contextPaletteItems = useMemo(
    () => commandSceneContextItems(scene, platformSnapshot, cwd),
    [cwd, platformSnapshot, scene],
  );
  const slashPaletteItems = useMemo(
    () => commandSceneSlashItems(platformSnapshot, slashCommands),
    [platformSnapshot, slashCommands],
  );
  const addPaletteItems = useMemo<PaletteItemWithCommand[]>(
    () => [
      {
        action: "attach-files",
        detail: "上传文本、DOCX 或 Excel 并加入本轮会话",
        kind: "file",
        label: "文件",
        title: "文件和文件夹",
      },
      {
        action: "attach-folder",
        detail: "选择本机目录，按相对路径读取支持的文件",
        kind: "file",
        label: "文件夹",
        title: "上传文件夹",
      },
      ...contextPaletteItems.filter((item) => item.kind === "knowledge"),
      ...slashPaletteItems.filter(
        (item) => item.kind === "skill" || item.kind === "mcp",
      ),
    ],
    [contextPaletteItems, slashPaletteItems],
  );
  const executionTargets = useMemo(
    () =>
      executionTargetOptionsFromDomain({
        ...executionTargetCatalog,
        platformAgents: platformSnapshot.agents,
      }),
    [executionTargetCatalog, platformSnapshot.agents],
  );
  const scenePreset = scenePresets[scene];
  const workspaceOptions = useMemo<CommandSelectOption[]>(() => {
    const paths = [cwd, ...linkedThreads.map((thread) => thread.cwd ?? "")]
      .map((path) => path.trim())
      .filter(
        (path, index, allPaths) => path && allPaths.indexOf(path) === index,
      );
    return [
      {
        detail: "不绑定项目文件夹，使用默认执行环境",
        label: "无工作空间",
        value: noWorkspaceValue,
      },
      ...paths.map((path) => ({
        detail: path,
        label: basename(path),
        value: path,
      })),
    ];
  }, [cwd, linkedThreads]);

  useEffect(() => {
    if (!executionTargets.some((target) => target.value === executionTarget)) {
      setExecutionTarget("crewon");
    }
  }, [executionTarget, executionTargets]);

  useEffect(() => {
    if (newTaskDraft || !selectedThread) {
      return;
    }
    const restoredTarget = agentPlatformTargetFromThreadSource(
      selectedThread.threadSource,
    );
    setExecutionTarget(
      restoredTarget &&
        executionTargets.some((target) => target.value === restoredTarget)
        ? restoredTarget
        : "crewon",
    );
  }, [executionTargets, newTaskDraft, selectedThread]);
  const visibleContextItems = useMemo(
    () => paletteFilter(contextPaletteItems, paletteQuery),
    [contextPaletteItems, paletteQuery],
  );
  const visibleSlashItems = useMemo(
    () => paletteFilter(slashPaletteItems, paletteQuery),
    [paletteQuery, slashPaletteItems],
  );
  const visibleAddItems = useMemo(
    () => paletteFilter(addPaletteItems, paletteQuery),
    [addPaletteItems, paletteQuery],
  );
  const commandLinkedThreads: CommandLinkedThread[] = useMemo(
    () =>
      linkedThreads.map((thread) => ({
        cwd: thread.cwd ?? null,
        id: thread.id,
        preview: thread.preview,
        title: sidebarThreadTitle(
          thread,
          locale === "zh" ? "未命名会话" : "Untitled thread",
        ),
        updatedAt: thread.updatedAt,
        updatedLabel: formatRelativeTime(thread.updatedAt, locale),
      })),
    [linkedThreads, locale],
  );
  const platformHasResources =
    platformSnapshot.agents.length +
      platformSnapshot.skills.length +
      platformSnapshot.mcpServers.length +
      platformSnapshot.knowledgeBases.length +
      platformSnapshot.workflows.length >
    0;
  const platformResourceStates = agentPlatformResourceStates(platformSnapshot);
  const platformResourceStateValues = Object.values(platformResourceStates);
  const platformState: PlatformLoadState = platformResourceStateValues.every(
    (state) => state.status === "loading",
  )
    ? "loading"
    : platformResourceStateValues.every((state) => state.status === "error") &&
        !platformHasResources
      ? "fallback"
      : "ready";
  const failedResourceCount = platformResourceStateValues.filter(
    (state) => state.status === "error",
  ).length;
  const resourceStatus =
    platformState === "loading"
      ? "正在读取当前账号的资源。"
      : platformState === "fallback"
        ? "Agent Platform 暂不可用，本地会话仍可使用。"
        : failedResourceCount > 0
          ? `${failedResourceCount} 类资源加载失败，其他资源和本地工作台仍可使用。`
          : platformHasResources
            ? "已读取当前账号的 Agent Platform 资源。"
            : "当前账号暂无已创建或已授权的资源。";

  async function reloadPlatformResources(
    category?: AgentPlatformResourceCategory,
  ) {
    const categories = category ? [category] : agentPlatformResourceCategories;
    setPlatformSnapshot((current) =>
      setAgentPlatformResourceState(current, categories, {
        status: "loading",
        error: null,
      }),
    );
    try {
      const incoming = await readAgentPlatformSnapshot();
      setPlatformSnapshot((current) =>
        mergeAgentPlatformSnapshot(current, incoming, categories),
      );
    } catch (reason) {
      const error =
        reason instanceof Error ? reason.message : "agent-platform unavailable";
      setPlatformSnapshot((current) =>
        setAgentPlatformResourceState(current, categories, {
          status: "error",
          error,
        }),
      );
    }
  }

  function switchView(view: CommandShellView) {
    setActiveView(view);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#view-${view}`);
    }
  }

  function switchScene(nextScene: CommandScene) {
    setScene(nextScene);
    setSceneMode("auto");
  }

  function prefillScenario(
    prompt: string,
    nextScene: CommandScene,
    mode: SceneInteractionMode,
  ) {
    switchScene(nextScene);
    setSceneMode(mode);
    onChangeComposerValue(prompt);
    textareaRef.current?.focus();
  }

  function selectPlatformResource(resource: AgentPlatformComposerResource) {
    const pimTarget = isPimExecutionTarget(executionTarget);
    const selectedResource: AgentPlatformComposerResource = {
      ...resource,
      execution:
        !pimTarget && resource.type === "skills" ? "local" : "remote",
    };
    if (!pimTarget && resource.type === "skills") {
      const skill = platformSnapshot.skills.find(
        (candidate) => candidate.id === resource.id,
      );
      if (!skill?.downloaded) {
        setComposerResourceError(
          `Skill“${resource.name}”需要先下载，才能由本地智能体使用。`,
        );
        return;
      }
    }
    const alreadySelected = selectedPlatformResources.some(
      (item) => item.type === resource.type && item.id === resource.id,
    );
    const nextResources = alreadySelected
      ? selectedPlatformResources
      : [...selectedPlatformResources, selectedResource];
    const compatibleAgent = pimTarget
      ? findCompatibleOnlineAgent(
          platformSnapshot,
          nextResources,
          executionTarget,
        )
      : null;
    if (pimTarget && !compatibleAgent) {
      setComposerResourceError(
        `当前 PIM Agent 没有同时绑定所选 ${nextResources
          .map(platformResourceLabel)
          .join("、")} 资源。`,
      );
      return;
    }

    setSelectedPlatformResources(nextResources);
    setComposerResourceError(null);
    const token = platformResourceToken(resource);
    if (!composerValue.includes(token)) {
      onChangeComposerValue(
        insertTokenIntoComposerValue({
          prefix: platformResourcePrefix(resource),
          token: resource.name,
          value: composerValue,
        }),
      );
    }
    closeComposerPalette();
    textareaRef.current?.focus();
  }

  function sendComposerValue() {
    const trimmed = composerValue.trim();
    if (
      isSending ||
      (!trimmed && composerImages.length === 0 && composerAttachments.length === 0)
    ) {
      return;
    }
    const pimTarget = isPimExecutionTarget(executionTarget);
    if (pimTarget && composerImages.length > 0) {
      setComposerResourceError(
        "远程 PIM Agent 当前不接收图片输入，请切换到 CrewON 本地智能体。",
      );
      return;
    }
    const referencedResources = selectedPlatformResources.filter((resource) =>
      trimmed.includes(platformResourceToken(resource)),
    );
    const compatibleAgent =
      pimTarget && referencedResources.length > 0
        ? findCompatibleOnlineAgent(
            platformSnapshot,
            referencedResources,
            executionTarget,
          )
        : null;
    if (pimTarget && referencedResources.length > 0 && !compatibleAgent) {
      setComposerResourceError(
        "所选资源未全部绑定到当前 PIM Agent，请减少资源或调整 Agent 绑定。",
      );
      return;
    }
    const effectiveExecutionTarget = executionTarget;
    const runtimeSettings = commandComposerRuntimeSettings({
      executionTarget: effectiveExecutionTarget,
      model,
      reasoningEffort: pimTarget ? undefined : reasoningEffort,
      permission,
      scene,
      sceneMode,
      executionIntent,
    });
    runtimeSettings.dynamicTools = pimTarget
      ? []
      : buildPimDynamicTools(referencedResources, platformSnapshot);
    const selectedAgentPlatformSource = agentPlatformTargetFromThreadSource(
      selectedThread?.threadSource,
    );
    const requestedAgentPlatformSource = agentPlatformThreadSource(
      runtimeSettings.agentPlatformAgentId,
    );
    const shouldCreateNewThread =
      newTaskDraft ||
      !selectedThread ||
      (!pimTarget && referencedResources.length > 0) ||
      ((selectedAgentPlatformSource !== null ||
        requestedAgentPlatformSource !== null) &&
        selectedAgentPlatformSource !== requestedAgentPlatformSource);
    const prompt = `${trimmed || (composerImages.length > 0 ? "请描述这张图片。" : "请分析这些附件。")}${attachmentContext(composerAttachments)}`;
    if (shouldCreateNewThread && onSendNewThread) {
      onSendNewThread(prompt, runtimeSettings, cwd || null, composerImages);
    } else {
      onSend(prompt, runtimeSettings, composerImages);
    }
    onChangeComposerValue("");
    setComposerImages([]);
    setComposerAttachments([]);
    setSelectedPlatformResources([]);
    setComposerResourceError(null);
    setNewTaskDraft(false);
    setExecutionIntent("none");
  }

  async function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      supportedComposerImageTypes.has(file.type),
    );
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    const availableSlots = maxComposerImages - composerImages.length;
    if (availableSlots <= 0) {
      setComposerResourceError(`每次最多添加 ${maxComposerImages} 张图片。`);
      return;
    }
    const accepted = files.slice(0, availableSlots);
    const oversized = accepted.find((file) => file.size > maxComposerImageBytes);
    if (oversized) {
      setComposerResourceError("图片不能超过 5MB。请压缩后再粘贴。");
      return;
    }
    try {
      const images = await Promise.all(
        accepted.map(async (file) => ({
          detail: "high" as const,
          url: await imageDataUrl(file),
        })),
      );
      setComposerImages((current) => [...current, ...images].slice(0, maxComposerImages));
      setComposerResourceError(null);
    } catch (error) {
      setComposerResourceError(
        error instanceof Error ? error.message : "无法读取粘贴的图片。",
      );
    }
  }

  async function addComposerFiles(files: File[]) {
    try {
      const attachments = await prepareComposerAttachments(files);
      setComposerAttachments((current) => {
        const merged = [...current, ...attachments];
        const ids = new Set<string>();
        return merged.filter((attachment) => {
          if (ids.has(attachment.id)) {
            return false;
          }
          ids.add(attachment.id);
          return true;
        });
      });
      setComposerResourceError(null);
    } catch (error) {
      setComposerResourceError(
        error instanceof Error ? error.message : "无法读取所选文件。",
      );
    }
  }

  function handleComposerDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    void addComposerFiles(Array.from(event.dataTransfer.files));
  }

  function openComposerPalette(kind: "add" | "context" | "slash") {
    setOpenPalette(kind);
    setPaletteQuery("");
  }

  function toggleComposerPalette(kind: "add" | "context" | "slash") {
    if (openPalette === kind) {
      closeComposerPalette();
      return;
    }
    openComposerPalette(kind);
  }

  function closeComposerPalette() {
    setOpenPalette(null);
    setPaletteQuery("");
  }

  useEffect(() => {
    if (!openPalette) {
      return;
    }

    function handleOutsidePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const paletteRoots = Array.from(
        document.querySelectorAll<HTMLElement>("[data-composer-palette]"),
      );
      const triggers = Array.from(
        document.querySelectorAll<HTMLElement>("[data-palette-trigger]"),
      );
      if (shouldCloseComposerPalette({ paletteRoots, target, triggers })) {
        closeComposerPalette();
      }
    }

    document.addEventListener("pointerdown", handleOutsidePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointerDown);
    };
  }, [openPalette]);

  function insertContextItem(item: PaletteItemWithCommand) {
    if (item.platformResource) {
      selectPlatformResource(item.platformResource);
      return;
    }
    onChangeComposerValue(
      insertTokenIntoComposerValue({
        prefix: "@",
        token: item.title,
        value: composerValue,
      }),
    );
    closeComposerPalette();
    textareaRef.current?.focus();
  }

  function insertSlashItem(item: PaletteItemWithCommand) {
    if (item.platformResource) {
      selectPlatformResource(item.platformResource);
      return;
    }
    if (item.command) {
      onSlashCommandSelect?.(item.command);
    }
    onChangeComposerValue(
      insertTokenIntoComposerValue({
        prefix: "/",
        token:
          item.command?.token ?? (item.token ?? item.title).replace(/^\$/, ""),
        value: composerValue,
      }),
    );
    closeComposerPalette();
    textareaRef.current?.focus();
  }

  function insertAddItem(item: PaletteItemWithCommand) {
    if (item.action === "attach-files") {
      closeComposerPalette();
      fileInputRef.current?.click();
      return;
    }
    if (item.action === "attach-folder") {
      closeComposerPalette();
      folderInputRef.current?.click();
      return;
    }
    if (item.kind === "skill" || item.kind === "mcp" || item.command) {
      insertSlashItem(item);
      return;
    }
    insertContextItem(item);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const intent = commandComposerKeyIntent({
      altKey: event.altKey,
      composerValue,
      ctrlKey: event.ctrlKey,
      hasOpenPalette: Boolean(openPalette),
      isComposing: event.nativeEvent.isComposing,
      key: event.key,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });

    if (intent === "closePalette") {
      event.preventDefault();
      closeComposerPalette();
      return;
    }
    if (intent === "send") {
      event.preventDefault();
      sendComposerValue();
      return;
    }
    if (intent === "openContext") {
      event.preventDefault();
      openComposerPalette("context");
      return;
    }
    if (intent === "openSlash") {
      event.preventDefault();
      openComposerPalette("slash");
    }
  }

  const currentWorkspace = basename(cwd || "工作空间");
  const activeOfficeRoom =
    officeRooms.find((room) => room.id === officeRoomId) ?? officeRooms[0];
  const activeWorkflowRoom =
    workflowRooms.find((room) => room.id === workflowRoomId) ??
    workflowRooms[0];
  const showCommandThread =
    activeView === "command" && Boolean(selectedThread) && !newTaskDraft;
  const commandThreadRunning = Boolean(activeTurnId);
  const connectionStatusLabel =
    connectionState === "connected"
      ? "App Server 已连接"
      : connectionState === "connecting"
        ? "正在连接 App Server"
        : connectionState === "demo"
          ? "演示模式"
          : "App Server 已断开";
  const composerActivityLabel = isSending
    ? "发送中"
    : commandThreadRunning && composerValue.trim()
      ? "继续补充指令"
      : commandThreadRunning
        ? "Agent 正在执行，可继续输入补充指令"
        : composerValue.trim()
          ? "草稿未发送"
          : null;
  const composerSendLabel = commandThreadRunning ? "发送补充指令" : "发送任务";

  return (
    <section
      className="screen-shell command-screen desktop-command-screen"
      data-od-id="desktop-command-screen"
      data-force-new-task={newTaskDraft ? "true" : "false"}
      data-locale={locale}
    >
      <section
        className={classNames(
          "desktop-window command-window",
          sidebarCollapsed && "sidebar-collapsed",
        )}
        data-od-id="desktop-window"
      >
        <CommandSidebar
          activeView={activeView}
          isSearchOpen={sidebarSearchOpen}
          cwd={cwd}
          linkedThreads={commandLinkedThreads}
          query={sidebarSearchQuery}
          selectedLinkedThreadId={activeLinkedThreadId}
          slots={slots}
          onCloseSearch={() => {
            setSidebarSearchOpen(false);
            setSidebarSearchQuery("");
          }}
          onCreateWorkspace={onChangeWorkspaceCwd}
          onNewThread={(workspaceCwd) => {
            setActiveLinkedThreadId(null);
            setNewTaskDraft(true);
            setSelectedPlatformResources([]);
            setComposerResourceError(null);
            onChangeWorkspaceCwd?.(workspaceCwd);
            onChangeComposerValue("");
            switchView("command");
            textareaRef.current?.focus();
          }}
          onOpenLinkedThread={(threadId) => {
            setActiveLinkedThreadId(threadId);
            setNewTaskDraft(false);
            setSelectedPlatformResources([]);
            setComposerResourceError(null);
            switchView("command");
            onSelectLinkedThread?.(threadId);
          }}
          onQueryChange={setSidebarSearchQuery}
          onSwitchView={switchView}
          onToggleCollapse={() =>
            setSidebarCollapsed((collapsed) => !collapsed)
          }
          onToggleSearch={() => setSidebarSearchOpen((open) => !open)}
          workspaceClient={executionTargetClient}
        />

        <section className="command-canvas" data-od-id="desktop-main-pane">
          <section
            className={classNames(
              "shell-view command-home-view",
              activeView === "command" && "active",
              showCommandThread && "has-command-thread",
            )}
            data-shell-view="command"
            data-shell-view-title-zh="新建任务"
            data-shell-view-title-en="New task"
            data-od-id="shell-view-command"
            data-has-thread={showCommandThread ? "true" : "false"}
            hidden={activeView !== "command"}
          >
            <section
              className={classNames(
                "hero-center",
                showCommandThread && "has-command-thread",
                showCommandThread && "conversation-shell",
              )}
              data-od-id="primary-work-area"
            >
              {showCommandThread && selectedThread ? (
                <CommandThreadRoom
                  activeTurnId={activeTurnId}
                  locale={locale}
                  selectedThread={selectedThread}
                  streamingText={streamingText}
                  workMode={workMode}
                  onModeChange={onModeChange}
                  onStop={onStop}
                />
              ) : (
                <>
                  <CommandSceneHeader
                    scene={scene}
                    onQuickAction={(action) =>
                      prefillScenario(action.prompt, scene, action.mode)
                    }
                    onSceneChange={switchScene}
                  />
                </>
              )}

              <section
                className={classNames(
                  "command-input",
                  showCommandThread && "thread-command-input",
                  showCommandThread && "conversation-frame",
                )}
                data-od-id="ai-composer"
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleComposerDrop}
              >
                <label className="visually-hidden" htmlFor="desktop-task-input">
                  任务输入
                </label>
                {composerImages.length > 0 ? (
                  <div className="composer-image-chips" aria-label="已添加的图片">
                    {composerImages.map((image, index) => (
                      <div className="composer-image-chip" key={image.url}>
                        <img alt={`待发送图片 ${index + 1}`} src={image.url} />
                        <button
                          aria-label={`移除图片 ${index + 1}`}
                          title="移除图片"
                          type="button"
                          onClick={() =>
                            setComposerImages((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index),
                            )
                          }
                        >
                          <X aria-hidden="true" size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {composerAttachments.length > 0 ? (
                  <div className="composer-attachment-chips" aria-label="已添加的文件">
                    {composerAttachments.map((attachment) => (
                      <div className="composer-attachment-chip" key={attachment.id}>
                        <FileText aria-hidden="true" size={14} />
                        <span title={attachment.relativePath}>{attachment.relativePath}</span>
                        <button
                          aria-label={`移除文件 ${attachment.name}`}
                          title="移除文件"
                          type="button"
                          onClick={() =>
                            setComposerAttachments((current) =>
                              current.filter((item) => item.id !== attachment.id),
                            )
                          }
                        >
                          <X aria-hidden="true" size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <input
                  accept=".txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.ts,.tsx,.js,.jsx,.py,.rs,.java,.sql,.docx,.xlsx,.xls"
                  className="composer-file-input"
                  multiple
                  ref={fileInputRef}
                  type="file"
                  onChange={(event) => {
                    void addComposerFiles(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = "";
                  }}
                />
                <input
                  className="composer-file-input"
                  multiple
                  ref={folderInputRef}
                  type="file"
                  {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                  onChange={(event) => {
                    void addComposerFiles(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = "";
                  }}
                />
                <textarea
                  aria-describedby="composer-status composer-error"
                  data-composer=""
                  data-od-id="composer-input"
                  id="desktop-task-input"
                  placeholder={scenePreset.placeholder}
                  ref={textareaRef}
                  value={composerValue}
                  onChange={(event) =>
                    onChangeComposerValue(event.currentTarget.value)
                  }
                  onKeyDown={handleComposerKeyDown}
                  onPaste={handleComposerPaste}
                />
                {composerResourceError ? (
                  <p className="composer-error" id="composer-error" role="alert">
                    {composerResourceError}
                  </p>
                ) : null}
                <button
                  aria-hidden="true"
                  className="shortcut-proxy"
                  data-context-open=""
                  data-palette-trigger="context"
                  hidden
                  tabIndex={-1}
                  type="button"
                  onClick={() => openComposerPalette("context")}
                />
                <button
                  aria-hidden="true"
                  className="shortcut-proxy"
                  data-slash-open=""
                  data-palette-trigger="slash"
                  hidden
                  tabIndex={-1}
                  type="button"
                  onClick={() => openComposerPalette("slash")}
                />

                <div className="input-tools" data-od-id="composer-tools">
                  <div
                    className="composer-controls"
                    data-od-id="composer-control-row"
                  >
                    <button
                      aria-label="添加上下文"
                      title="添加上下文；也可直接粘贴图片"
                      className="icon-action composer-plus-action"
                      data-palette-trigger="add"
                      type="button"
                      onClick={() => toggleComposerPalette("add")}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                    <span className="visually-hidden">
                      <ImagePlus aria-hidden="true" /> 可直接粘贴 PNG、JPEG 或 WebP 图片
                    </span>
                    <CommandComposerSelect
                      ariaLabel="权限选择"
                      className="permission-dropdown"
                      icon={<ShieldCheck aria-hidden="true" />}
                      options={permissionOptions}
                      value={permission}
                      onChange={setPermission}
                    />
                    <div
                      aria-label="执行意图"
                      className="execution-intent-switch"
                      role="group"
                    >
                      <button
                        aria-pressed={executionIntent === "goal"}
                        className="execution-intent-button"
                        data-execution-intent="goal"
                        title="持续追求当前任务目标"
                        type="button"
                        onClick={() =>
                          setExecutionIntent((current) =>
                            nextExecutionIntent(current, "goal"),
                          )
                        }
                      >
                        <Target aria-hidden="true" />
                        <span>目标</span>
                      </button>
                      <button
                        aria-pressed={executionIntent === "plan"}
                        className="execution-intent-button"
                        data-execution-intent="plan"
                        title="先制定计划，不直接执行"
                        type="button"
                        onClick={() =>
                          setExecutionIntent((current) =>
                            nextExecutionIntent(current, "plan"),
                          )
                        }
                      >
                        <ListChecks aria-hidden="true" />
                        <span>计划</span>
                      </button>
                    </div>
                  </div>

                  <div
                    className="composer-actions"
                    data-od-id="composer-action-row"
                  >
                    <CommandComposerSelect
                      ariaLabel="执行主体"
                      className="execution-target-dropdown"
                      options={executionTargets}
                      value={executionTarget}
                      onChange={(value) => {
                        setExecutionTarget(value);
                        setSelectedPlatformResources([]);
                        setComposerResourceError(null);
                      }}
                    />
                    <CommandComposerSelect
                      ariaLabel="模型选择"
                      className="model-dropdown"
                      options={effectiveModelOptions}
                      value={model}
                      onChange={(nextModel) => {
                        setModelSelectionTouched(true);
                        setModel(nextModel);
                      }}
                    />
                    {!isPimExecutionTarget(executionTarget) ? (
                      <CommandComposerSelect
                        ariaLabel="推理强度"
                        className="reasoning-dropdown"
                        options={[
                          { label: "轻度", value: "low" },
                          { label: "中", value: "medium" },
                          { label: "高", value: "high" },
                          { label: "极高", value: "xhigh" },
                        ]}
                        value={reasoningEffort}
                        onChange={setReasoningEffort}
                      />
                    ) : null}
                    <button
                      aria-busy={isSending && !commandThreadRunning}
                      aria-label={
                        commandThreadRunning
                          ? "停止任务"
                          : showCommandThread
                            ? composerSendLabel
                            : "开始任务"
                      }
                      className="send-button"
                      data-action={commandThreadRunning ? "stop" : "send"}
                      disabled={
                        commandThreadRunning
                          ? !onStop
                          : isSending || !composerValue.trim()
                      }
                      title={
                        commandThreadRunning
                          ? "停止任务"
                          : showCommandThread
                            ? composerSendLabel
                            : "开始任务"
                      }
                      type="button"
                      onClick={commandThreadRunning ? onStop : sendComposerValue}
                    >
                      {commandThreadRunning ? (
                        <Square aria-hidden="true" />
                      ) : (
                        <ArrowUp aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>

                <Palette
                  id="add-search-panel"
                  inputId="add-search"
                  items={visibleAddItems}
                  kind="add"
                  open={openPalette === "add"}
                  placeholder="添加文件、知识库、Skill 或 MCP"
                  query={paletteQuery}
                  onClose={closeComposerPalette}
                  onQueryChange={setPaletteQuery}
                  onSelect={insertAddItem}
                />
                <Palette
                  id="context-search-panel"
                  inputId="context-search"
                  items={visibleContextItems}
                  kind="context"
                  open={openPalette === "context"}
                  placeholder="搜索文件、会话或工作空间"
                  query={paletteQuery}
                  onClose={closeComposerPalette}
                  onQueryChange={setPaletteQuery}
                  onSelect={insertContextItem}
                />
                <Palette
                  id="slash-search-panel"
                  inputId="slash-search"
                  items={visibleSlashItems}
                  kind="slash"
                  open={openPalette === "slash"}
                  placeholder="搜索 Skill 或 MCP，例如 页面审阅、Filesystem"
                  query={paletteQuery}
                  onClose={closeComposerPalette}
                  onQueryChange={setPaletteQuery}
                  onSelect={insertSlashItem}
                />

                <div
                  className="composer-state-row"
                  data-od-id="composer-state-row"
                  id="composer-status"
                >
                  {showCommandThread ? (
                    <span
                      className="workspace-label"
                      data-od-id="workspace-picker"
                    >
                      {currentWorkspace}
                    </span>
                  ) : (
                    <CommandComposerSelect
                      ariaLabel="工作空间选择"
                      className="workspace-dropdown"
                      options={workspaceOptions}
                      value={cwd || noWorkspaceValue}
                      onChange={(nextWorkspace) =>
                        onChangeWorkspaceCwd?.(
                          nextWorkspace === noWorkspaceValue
                            ? null
                            : nextWorkspace,
                        )
                      }
                    />
                  )}
                  {composerActivityLabel ? (
                    <span className="composer-state">
                      {composerActivityLabel}
                    </span>
                  ) : null}
                  {connectionState === "disconnected" ? (
                    <button
                      className="button compact"
                      type="button"
                      onClick={onRetryConnection}
                    >
                      重试 app-server
                    </button>
                  ) : null}
                  <span
                    aria-label={connectionStatusLabel}
                    className="connection-indicator"
                    data-state={connectionState}
                    role="status"
                    title={connectionStatusLabel}
                  />
                </div>
              </section>
            </section>

          </section>

          <AssistView
            active={activeView === "assist"}
            composerValue={composerValue}
            connectionState={connectionState}
            onChangeComposerValue={onChangeComposerValue}
            onSend={sendComposerValue}
          />
          <ProjectsView
            active={activeView === "projects"}
            resourceStatus={resourceStatus}
          />
          <AgentsView
            active={activeView === "agents"}
            catalogFilter={catalogFilter}
            catalogSearch={catalogSearch}
            platformState={platformState}
            resourceStates={platformResourceStates}
            snapshot={platformSnapshot}
            onReload={reloadPlatformResources}
            onCatalogFilterChange={setCatalogFilter}
            onCatalogSearchChange={setCatalogSearch}
          />
          <KnowledgeCatalogView
            active={activeView === "knowledge"}
            platformState={platformState}
            resourceStates={platformResourceStates}
            snapshot={platformSnapshot}
            onReload={reloadPlatformResources}
          />
          <ScheduleView
            active={activeView === "schedule"}
            modalOpen={scheduleModalOpen}
            scheduleMode={scheduleMode}
            scheduleSource={scheduleSource}
            onCloseModal={() => setScheduleModalOpen(false)}
            onModeChange={setScheduleMode}
            onOpenModal={() => setScheduleModalOpen(true)}
            onSourceChange={setScheduleSource}
          />
          <TeamView
            active={activeView === "team"}
            activeOfficeRoom={activeOfficeRoom}
            activeWorkflowRoom={activeWorkflowRoom}
            officeRoomId={officeRoomId}
            officeTab={officeTab}
            teamMode={teamMode}
            workflowRoomId={workflowRoomId}
            workflowTab={workflowTab}
            onBackOffice={() => setOfficeRoomId(null)}
            onBackWorkflow={() => setWorkflowRoomId(null)}
            onOfficeTabChange={setOfficeTab}
            onOpenOffice={setOfficeRoomId}
            onOpenWorkflow={setWorkflowRoomId}
            onTeamModeChange={(mode) => {
              setTeamMode(mode);
              setOfficeRoomId(null);
              setWorkflowRoomId(null);
            }}
            onWorkflowTabChange={setWorkflowTab}
          />
        </section>
      </section>
    </section>
  );
}
