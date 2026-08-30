import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ControlApiClient } from "@crewon/control-client";
import {
  ListChecks,
  Plus,
  Settings2,
  ShieldCheck,
  Target,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Locale } from "../../lib/i18n";
import { mentionsWithSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { ControlThreadRuntime } from "../../lib/control-runtime/controlThreadRuntime";
import {
  attachmentContext,
  prepareComposerAttachments,
  type ComposerAttachment,
} from "../../lib/shared/composerAttachments";
import {
  isControlOfficeDefinitionRecord,
  officeMemberDisplayName,
  officeRecordKey,
  type ControlOfficeDefinitionRecordReference,
} from "../../lib/office/officePanelFromRecord";
import {
  officeMemberAgentProfileId,
  readOfficeMemberAgentProfile,
} from "../../lib/office/officeMemberAgentProfile";
import type { PendingComposerMention } from "../../lib/shared/composerMentions";
import {
  platformResourceMentionPath,
  withPlatformResourceMention,
} from "../../lib/shared/composerResourceMentions";
import {
  commandComposerRuntimeSettings,
  fallbackCommandModelOptions,
  type CommandComposerPermission,
  type CommandExecutionIntent,
  type TeamMemberRuntimeProfile,
  type ThreadRuntimeSettings,
} from "../../lib/thread/threadRuntimeSettings";
import {
  commandModelEffortLabel,
  commandReasoningEffortOptions,
  resolveReasoningEffort,
} from "../../lib/thread/threadReasoningEffort";
import {
  CommandComposer,
  CommandComposerSelect,
} from "../composer/CommandComposer";
import {
  ComposerResourceTags,
  type ComposerResourceTag,
} from "../composer/ComposerResourceTags";
import { commandComposerPermissionOptions } from "../composer/commandComposerPermissionOptions";
import {
  effortFromOptionValue,
  effortOptionValue,
  modelEffortGroups,
  modelEffortMenuOptions,
} from "../composer/composerModelEffortMenu";
import {
  commandComposerResourceSelection,
  nextExecutionIntent,
  type CommandOfficeComposerCapabilities,
  type CommandOfficeRoomAdapter,
} from "./CommandWorkspace";
import { Palette, type PaletteItemWithCommand } from "./CommandWorkspaceChrome";
import {
  ControlOfficeDefinitionRoom,
  type ControlOfficeMemberAgentSettingsBridge,
} from "./ControlOfficeDefinitionRoom";
import {
  controlOfficeChatErrorMessage,
  controlOfficeChatMessages,
  controlOfficeThreadTitle,
  legacyControlOfficeThreadTitle,
} from "./controlOfficeChatPresentation";

type ControlOfficeChatClient = Pick<
  ControlApiClient,
  "createOffice" | "createThread" | "getOffice"
>;
type ControlOfficeThreadRuntime = Pick<
  ControlThreadRuntime,
  "interruptTurn" | "listThreads" | "readThread" | "renameThread" | "startTurn"
>;

function createIdempotencyKey(operation: string) {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
  return `office.chat.${operation}:${randomId}`;
}

const emptyOfficeComposerCapabilities: CommandOfficeComposerCapabilities = {
  contextItems: [],
  modelOptions: fallbackCommandModelOptions,
  slashItems: [],
};

function paletteFilter(items: PaletteItemWithCommand[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter((item) =>
    [item.label, item.title, item.detail, item.token]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalized),
  );
}

function insertComposerToken(
  value: string,
  prefix: "@" | "/",
  token: string,
): string {
  const normalized = token.trim();
  if (!normalized) return value;
  const nextToken = normalized.startsWith(prefix)
    ? normalized
    : `${prefix}${normalized}`;
  const current = value.trimEnd();
  return current ? `${current} ${nextToken} ` : `${nextToken} `;
}

function mentionResources(
  mentions: PendingComposerMention[],
  locale: Locale,
): ComposerResourceTag[] {
  const labels: Record<ComposerResourceTag["kind"], string> = {
    file: locale === "zh" ? "文件" : "File",
    folder: locale === "zh" ? "文件夹" : "Folder",
    image: locale === "zh" ? "图片" : "Image",
    knowledge: locale === "zh" ? "知识库" : "Knowledge",
    mcp: "MCP",
    skill: "Skill",
  };
  return mentions.map((mention) => {
    const kind: ComposerResourceTag["kind"] =
      mention.resourceKind ??
      (mention.kind === "skill"
        ? "skill"
        : mention.path.startsWith("mcp://")
          ? "mcp"
          : "knowledge");
    return {
      id: mention.path,
      kind,
      label: labels[kind],
      name: mention.name,
    };
  });
}

export function controlOfficeRuntimeMemberProfiles(
  record: ControlOfficeDefinitionRecordReference,
): TeamMemberRuntimeProfile[] {
  return record.definition.members.flatMap((member) => {
    const profile = readOfficeMemberAgentProfile(
      officeMemberAgentProfileId(
        record.definition.officeVersionId,
        member.memberId,
      ),
    );
    if (!profile) return [];
    const selected = (options: typeof profile.skills) =>
      options
        .filter((option) => option.enabled)
        .map(({ name, description }) => ({ name, description }));
    return [
      {
        memberId: member.memberId,
        systemPrompt: profile.systemPrompt,
        skills: selected(profile.skills),
        mcp: selected(profile.mcp),
        knowledge: selected(profile.knowledge),
      },
    ];
  });
}

export function controlOfficeComposerRuntimeSettings({
  executionIntent,
  model,
  permission,
  reasoningEffort,
  record,
}: {
  executionIntent: CommandExecutionIntent;
  model: string;
  permission: CommandComposerPermission;
  reasoningEffort: string | null;
  record: ControlOfficeDefinitionRecordReference;
}): ThreadRuntimeSettings {
  return {
    ...commandComposerRuntimeSettings({
      executionIntent,
      model,
      permission,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }),
    teamMemberProfiles: controlOfficeRuntimeMemberProfiles(record),
    scene: {
      executionTarget: {
        id: record.definition.officeVersionId,
        kind: "team",
      },
      mode: "coordinate",
      sceneId: "office",
    },
    threadSource: "office",
  };
}

function ControlOfficeChatRoom({
  agentSettings,
  client,
  composer,
  locale,
  onBack,
  record,
  runtime,
}: {
  agentSettings?: ControlOfficeMemberAgentSettingsBridge;
  client: ControlOfficeChatClient;
  composer: CommandOfficeComposerCapabilities;
  locale: Locale;
  onBack: () => void;
  record: ControlOfficeDefinitionRecordReference;
  runtime: ControlOfficeThreadRuntime;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [activeRecord, setActiveRecord] = useState(record);
  const [definitionOpen, setDefinitionOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [executionIntent, setExecutionIntent] =
    useState<CommandExecutionIntent>("none");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [pendingMentions, setPendingMentions] = useState<
    PendingComposerMention[]
  >([]);
  const [permission, setPermission] =
    useState<CommandComposerPermission>("approve-for-me");
  const [model, setModel] = useState(
    composer.modelOptions.find((option) => option.isDefault)?.value ??
      composer.modelOptions[0]?.value ??
      fallbackCommandModelOptions[0].value,
  );
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<
    string | null
  >(null);
  const [openPalette, setOpenPalette] = useState<
    "add" | "context" | "slash" | null
  >(null);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const title = useMemo(
    () => controlOfficeThreadTitle(activeRecord),
    [activeRecord],
  );
  const legacyTitle = useMemo(
    () => legacyControlOfficeThreadTitle(activeRecord),
    [activeRecord],
  );
  const leaderName =
    (activeRecord.definition.members[0]
      ? officeMemberDisplayName(
          activeRecord.definition.members[0].displayName,
          0,
          locale,
        )
      : null) ?? (locale === "zh" ? "办公室组长" : "Office manager");
  const effectiveModelOptions =
    composer.modelOptions.length > 0
      ? composer.modelOptions
      : fallbackCommandModelOptions;
  const reasoningEffortOptions = commandReasoningEffortOptions(
    effectiveModelOptions,
    model,
    locale,
  );
  const effectiveReasoningEffort = resolveReasoningEffort(
    effectiveModelOptions,
    model,
    selectedReasoningEffort,
  );
  const modelTriggerLabel = commandModelEffortLabel({
    effort: reasoningEffortOptions.length > 0 ? effectiveReasoningEffort : null,
    locale,
    modelLabel:
      effectiveModelOptions.find((option) => option.value === model)?.label ??
      model,
  });
  const modelEffortOptions = modelEffortMenuOptions({
    effortOptions: reasoningEffortOptions,
    modelOptions: effectiveModelOptions,
  });
  const addPaletteItems = useMemo<PaletteItemWithCommand[]>(
    () => [
      {
        action: "intent-goal",
        active: executionIntent === "goal",
        detail:
          locale === "zh"
            ? "围绕一个目标持续推进"
            : "Keep working toward one goal",
        kind: "intent",
        label: locale === "zh" ? "目标" : "Goal",
        title: locale === "zh" ? "目标模式" : "Goal mode",
      },
      {
        action: "intent-plan",
        active: executionIntent === "plan",
        detail:
          locale === "zh"
            ? "先给出计划，确认后再执行"
            : "Draft a plan before execution",
        kind: "intent",
        label: locale === "zh" ? "计划" : "Plan",
        title: locale === "zh" ? "计划模式" : "Plan mode",
      },
      {
        action: "attach-files",
        detail:
          locale === "zh"
            ? "从电脑选择一个或多个文件"
            : "Choose one or more files",
        kind: "file",
        label: locale === "zh" ? "文件" : "File",
        title: locale === "zh" ? "选择文件" : "Choose files",
      },
      {
        action: "attach-folder",
        detail: locale === "zh" ? "从电脑选择文件夹" : "Choose a folder",
        kind: "folder",
        label: locale === "zh" ? "文件夹" : "Folder",
        title: locale === "zh" ? "选择文件夹" : "Choose folder",
      },
      ...composer.contextItems.filter((item) => item.kind === "knowledge"),
      ...composer.slashItems.filter(
        (item) => item.kind === "skill" || item.kind === "mcp",
      ),
    ],
    [composer.contextItems, composer.slashItems, executionIntent, locale],
  );
  const visibleAddItems = paletteFilter(addPaletteItems, paletteQuery);
  const visibleContextItems = paletteFilter(
    composer.contextItems,
    paletteQuery,
  );
  const visibleSlashItems = paletteFilter(composer.slashItems, paletteQuery);

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    if (effectiveModelOptions.some((option) => option.value === model)) return;
    setModel(
      effectiveModelOptions.find((option) => option.isDefault)?.value ??
        effectiveModelOptions[0]?.value ??
        fallbackCommandModelOptions[0].value,
    );
  }, [effectiveModelOptions, model]);

  useEffect(() => {
    if (!openPalette) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      const element =
        target instanceof Element
          ? target
          : target instanceof Node
            ? target.parentElement
            : null;
      if (element?.closest("[data-composer-palette], [data-palette-trigger]")) {
        return;
      }
      setOpenPalette(null);
      setPaletteQuery("");
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [openPalette]);

  const refreshThread = useCallback(
    async (id: string) => {
      const nextThread = await runtime.readThread(id);
      setThread(nextThread);
      return nextThread;
    },
    [runtime],
  );

  useEffect(() => {
    let canceled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void runtime
      .listThreads(false)
      .then(async (threads) => {
        const match =
          threads.find((candidate) => candidate.name === title) ??
          threads.find((candidate) => candidate.name === legacyTitle);
        if (!match) {
          return null;
        }
        if (match.name === legacyTitle) {
          await runtime.renameThread(match.id, title).catch(() => undefined);
        }
        const nextThread = await runtime.readThread(match.id, {
          signal: controller.signal,
        });
        return { id: match.id, thread: nextThread };
      })
      .then((result) => {
        if (canceled) {
          return;
        }
        setThreadId(result?.id ?? null);
        setThread(result?.thread ?? null);
      })
      .catch((reason: unknown) => {
        if (!canceled) {
          setError(controlOfficeChatErrorMessage(reason, locale));
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoading(false);
        }
      });
    return () => {
      canceled = true;
      controller.abort();
    };
  }, [legacyTitle, locale, runtime, title]);

  useEffect(() => {
    if (!threadId || (!submitting && thread?.status.type !== "active")) {
      return;
    }
    const controller = new AbortController();
    let timeoutId: number | null = null;
    const refresh = async () => {
      try {
        const nextThread = await runtime.readThread(threadId, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setThread(nextThread);
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(controlOfficeChatErrorMessage(reason, locale));
        }
      } finally {
        if (!controller.signal.aborted) {
          timeoutId = window.setTimeout(() => void refresh(), 1_500);
        }
      }
    };
    timeoutId = window.setTimeout(() => void refresh(), 1_500);
    return () => {
      controller.abort();
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [locale, runtime, submitting, thread?.status.type, threadId]);

  async function submitMessage() {
    const text = draft.trim();
    if (!text || submitting || loading) {
      return;
    }
    setSubmitting(true);
    setPendingMessage(text);
    setError(null);
    setDraft("");
    try {
      let activeThreadId = threadId;
      if (!activeThreadId) {
        const created = await client.createThread(
          { title },
          createIdempotencyKey("thread.create"),
        );
        activeThreadId = created.thread.threadId;
        setThreadId(activeThreadId);
      }
      await runtime.startTurn(
        activeThreadId,
        `${text}${attachmentContext(attachments)}`,
        pendingMentions,
        controlOfficeComposerRuntimeSettings({
          executionIntent,
          model,
          permission,
          reasoningEffort: effectiveReasoningEffort,
          record: activeRecord,
        }),
      );
      await refreshThread(activeThreadId);
      setAttachmentFiles([]);
      setAttachments([]);
      setExecutionIntent("none");
      setPendingMentions([]);
    } catch (reason) {
      setDraft(text);
      setPendingMessage(null);
      setError(controlOfficeChatErrorMessage(reason, locale));
    } finally {
      setSubmitting(false);
    }
  }

  async function stopActiveTurn() {
    if (!threadId || submitting) return;
    const activeTurn = [...(thread?.turns ?? [])]
      .reverse()
      .find((turn) => turn.status === "inProgress");
    if (!activeTurn) return;
    setSubmitting(true);
    setError(null);
    try {
      await runtime.interruptTurn(threadId, activeTurn.id);
      await refreshThread(threadId);
    } catch (reason) {
      setError(controlOfficeChatErrorMessage(reason, locale));
    } finally {
      setSubmitting(false);
    }
  }

  function closeComposerPalette() {
    setOpenPalette(null);
    setPaletteQuery("");
  }

  function openComposerPalette(kind: "add" | "context" | "slash") {
    setOpenPalette(kind);
    setPaletteQuery("");
  }

  function toggleAddPalette() {
    if (openPalette === "add") {
      closeComposerPalette();
      return;
    }
    openComposerPalette("add");
  }

  function selectModelOrEffort(nextValue: string) {
    const effort = effortFromOptionValue(nextValue);
    if (effort) {
      setSelectedReasoningEffort(effort);
      return;
    }
    setModel(nextValue);
  }

  function selectContextItem(item: PaletteItemWithCommand) {
    const selection = commandComposerResourceSelection(item);
    if (selection) {
      setPendingMentions((current) =>
        withPlatformResourceMention(current, {
          ...(selection.content ? { content: selection.content } : {}),
          kind: selection.kind,
          name: selection.name,
          path: platformResourceMentionPath(selection.platformResource),
        }),
      );
    } else {
      setDraft((current) => insertComposerToken(current, "@", item.title));
    }
    closeComposerPalette();
    textareaRef.current?.focus();
  }

  function selectSlashItem(item: PaletteItemWithCommand) {
    const command = item.command;
    if (command) {
      setPendingMentions((current) =>
        mentionsWithSlashCommand(current, command),
      );
      if (command.kind === "app") {
        setDraft((current) => insertComposerToken(current, "/", command.token));
      }
    } else {
      const selection = commandComposerResourceSelection(item);
      if (selection) {
        setPendingMentions((current) =>
          withPlatformResourceMention(current, {
            ...(selection.content ? { content: selection.content } : {}),
            kind: selection.kind,
            name: selection.name,
            path: platformResourceMentionPath(selection.platformResource),
          }),
        );
      } else {
        setDraft((current) =>
          insertComposerToken(current, "/", item.token ?? item.title),
        );
      }
    }
    closeComposerPalette();
    textareaRef.current?.focus();
  }

  function selectAddItem(item: PaletteItemWithCommand) {
    if (item.action === "intent-goal" || item.action === "intent-plan") {
      const selected = item.action === "intent-goal" ? "goal" : "plan";
      setExecutionIntent((current) => nextExecutionIntent(current, selected));
      closeComposerPalette();
      textareaRef.current?.focus();
      return;
    }
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
      selectSlashItem(item);
      return;
    }
    selectContextItem(item);
  }

  async function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (selectedFiles.length === 0) {
      return;
    }
    const nextFiles = [...attachmentFiles, ...selectedFiles].filter(
      (file, index, files) =>
        files.findIndex(
          (candidate) =>
            candidate.name === file.name &&
            candidate.lastModified === file.lastModified &&
            candidate.size === file.size,
        ) === index,
    );
    try {
      const nextAttachments = await prepareComposerAttachments(nextFiles);
      setAttachmentFiles(nextFiles);
      setAttachments(nextAttachments);
      setAttachmentError(null);
    } catch (reason) {
      setAttachmentError(
        reason instanceof Error
          ? reason.message
          : locale === "zh"
            ? "文件没有添加成功，请换一个文件再试。"
            : "The file could not be added. Try another file.",
      );
    }
  }

  if (definitionOpen) {
    return (
      <ControlOfficeDefinitionRoom
        agentSettings={agentSettings}
        client={client}
        locale={locale}
        record={activeRecord}
        onBack={() => setDefinitionOpen(false)}
        onSaved={setActiveRecord}
      />
    );
  }

  const persistedMessages = controlOfficeChatMessages(
    thread,
    leaderName,
    locale,
  );
  const messages =
    pendingMessage &&
    !persistedMessages.some(
      (message) => message.self && message.text === pendingMessage,
    )
      ? [
          ...persistedMessages,
          {
            author: locale === "zh" ? "你" : "You",
            glyph: "@",
            id: "pending:user",
            self: true,
            text: pendingMessage,
            time: "",
          },
        ]
      : persistedMessages;
  const isActive = submitting || thread?.status.type === "active";
  const chatMemberNames = activeRecord.definition.members.map((member, index) =>
    officeMemberDisplayName(member.displayName, index, locale),
  );
  const visibleChatMembers = activeRecord.definition.members.slice(0, 4);
  const hiddenChatMemberCount = Math.max(
    activeRecord.definition.members.length - visibleChatMembers.length,
    0,
  );
  return (
    <main
      aria-label={activeRecord.config.title}
      className="office-workspace control-office-chat-room"
      data-control-office-chat=""
    >
      <header className="office-top">
        <button className="office-back" type="button" onClick={onBack}>
          {locale === "zh" ? "返回" : "Back"}
        </button>
        <div className="office-top-title" title={activeRecord.config.title}>
          <h1>{activeRecord.config.title}</h1>
          <p>
            {locale === "zh" ? "办公室群聊" : "Office group chat"} ·{" "}
            {leaderName} · {activeRecord.definition.members.length}{" "}
            {locale === "zh" ? "名成员" : "members"}
          </p>
        </div>
        <div className="office-top-actions">
          <div
            aria-label={`${locale === "zh" ? "群聊成员" : "Group chat members"}：${chatMemberNames.join(locale === "zh" ? "、" : ", ")}`}
            className="control-office-chat-members"
            role="img"
            title={`${locale === "zh" ? "群聊" : "Group chat"} · ${chatMemberNames.join(locale === "zh" ? "、" : ", ")}`}
          >
            {visibleChatMembers.map((member, index) => {
              const name = officeMemberDisplayName(
                member.displayName,
                index,
                locale,
              );
              return (
                <span key={member.memberId} aria-hidden="true">
                  {Array.from(name.trim())[0] || (locale === "zh" ? "员" : "M")}
                </span>
              );
            })}
            {hiddenChatMemberCount > 0 ? (
              <span
                className="control-office-chat-member-count"
                aria-hidden="true"
              >
                +{hiddenChatMemberCount}
              </span>
            ) : null}
          </div>
          <button
            aria-label={locale === "zh" ? "成员设置" : "Member settings"}
            className="control-office-member-settings-button"
            title={locale === "zh" ? "成员设置" : "Member settings"}
            type="button"
            onClick={() => setDefinitionOpen(true)}
          >
            <Settings2 aria-hidden="true" />
          </button>
          {error || isActive ? (
            <span
              className="office-runtime-status"
              data-runtime-status={error ? "error" : "running"}
            >
              {error
                ? locale === "zh"
                  ? "需要重试"
                  : "Retry needed"
                : locale === "zh"
                  ? "协作中"
                  : "Working"}
            </span>
          ) : null}
        </div>
      </header>

      <div className="office-room-body">
        <section
          className="office-chat"
          aria-label={locale === "zh" ? "群聊" : "Group chat"}
        >
          <div
            aria-busy={isActive}
            aria-live="polite"
            aria-relevant="additions text"
            className="office-chat-stream"
            role="log"
          >
            {loading ? (
              <div className="office-chat-empty" role="status">
                <strong>
                  {locale === "zh" ? "正在进入群聊" : "Opening group chat"}
                </strong>
                <p>
                  {locale === "zh"
                    ? "正在加载聊天记录。"
                    : "Loading the chat history."}
                </p>
              </div>
            ) : messages.length === 0 ? (
              <div className="office-chat-empty">
                <strong>
                  {locale === "zh" ? "还没有消息" : "No messages yet"}
                </strong>
                <p>
                  {locale === "zh"
                    ? "在下方告诉组长一个真实目标，后续消息会继续留在这个办公室群聊中。"
                    : "Give the manager a real goal below. Follow-up messages stay in this Office chat."}
                </p>
              </div>
            ) : null}
            {messages.map((message) => (
              <div
                className="office-bubble"
                data-kind="message"
                data-self={message.self}
                key={message.id}
              >
                <span
                  className="office-avatar office-avatar-sm"
                  aria-hidden="true"
                >
                  {message.self
                    ? locale === "zh"
                      ? "你"
                      : "You"
                    : message.glyph}
                </span>
                <div className="office-bubble-body">
                  <div className="office-bubble-head">
                    <strong>{message.author}</strong>
                    <span>{message.time}</span>
                  </div>
                  <p>{message.text}</p>
                </div>
              </div>
            ))}
            {isActive ? (
              <div className="office-system" role="status">
                {locale === "zh"
                  ? "办公室成员正在执行，组长会在这里统一回复。"
                  : "Office members are working; the manager will reply here."}
              </div>
            ) : null}
            {error ? (
              <div className="control-office-chat-error" role="alert">
                {error}
              </div>
            ) : null}
          </div>

          <input
            ref={fileInputRef}
            accept=".csv,.docx,.html,.js,.jsx,.json,.md,.py,.rs,.sql,.ts,.tsx,.txt,.xls,.xlsx,.xml,.yaml,.yml"
            aria-label={locale === "zh" ? "选择文件" : "Choose files"}
            hidden
            multiple
            type="file"
            onChange={(event) => void addFiles(event)}
          />
          <input
            ref={folderInputRef}
            aria-label={locale === "zh" ? "选择文件夹" : "Choose a folder"}
            hidden
            multiple
            type="file"
            onChange={(event) => void addFiles(event)}
          />
          <CommandComposer
            actions={
              <CommandComposerSelect
                activeValues={[
                  model,
                  ...(effectiveReasoningEffort
                    ? [effortOptionValue(effectiveReasoningEffort)]
                    : []),
                ]}
                ariaLabel={
                  locale === "zh" ? "模型与推理档位" : "Model and effort"
                }
                className="max-w-[138px]"
                groups={modelEffortGroups(locale)}
                options={modelEffortOptions}
                triggerLabel={modelTriggerLabel}
                value={model}
                onChange={selectModelOrEffort}
              />
            }
            beforeTextarea={
              <>
                <ComposerResourceTags
                  resources={[
                    ...attachments.map((attachment) => ({
                      id: attachment.id,
                      kind: "file" as const,
                      label: locale === "zh" ? "文件" : "File",
                      name: attachment.name,
                    })),
                    ...mentionResources(pendingMentions, locale),
                  ]}
                  onRemove={(resource) => {
                    if (
                      attachments.some(
                        (attachment) => attachment.id === resource.id,
                      )
                    ) {
                      setAttachmentFiles((current) =>
                        current.filter(
                          (file) =>
                            `${file.name}-${file.lastModified}-${file.size}` !==
                            resource.id,
                        ),
                      );
                      setAttachments((current) =>
                        current.filter(
                          (attachment) => attachment.id !== resource.id,
                        ),
                      );
                      setAttachmentError(null);
                      return;
                    }
                    setPendingMentions((current) =>
                      current.filter((mention) => mention.path !== resource.id),
                    );
                  }}
                />
              </>
            }
            ariaDescribedBy="control-office-composer-status"
            ariaLabel={locale === "zh" ? "群聊输入" : "Group chat input"}
            className="command-input thread-command-input control-office-chat-composer"
            controls={
              <>
                <button
                  aria-label={locale === "zh" ? "添加上下文" : "Add context"}
                  className="icon-action composer-plus-action"
                  data-palette-trigger="add"
                  type="button"
                  onClick={toggleAddPalette}
                >
                  <Plus aria-hidden="true" />
                </button>
                <CommandComposerSelect
                  ariaLabel={locale === "zh" ? "权限选择" : "Permissions"}
                  className="max-w-[180px]"
                  icon={<ShieldCheck aria-hidden="true" />}
                  options={commandComposerPermissionOptions(locale)}
                  value={permission}
                  onChange={setPermission}
                />
                {executionIntent !== "none" ? (
                  <button
                    aria-label={
                      executionIntent === "goal"
                        ? locale === "zh"
                          ? "取消目标执行意图"
                          : "Clear goal execution intent"
                        : locale === "zh"
                          ? "取消计划执行意图"
                          : "Clear plan execution intent"
                    }
                    className="execution-intent-chip"
                    data-execution-intent={executionIntent}
                    title={locale === "zh" ? "点击取消" : "Click to clear"}
                    type="button"
                    onClick={() => setExecutionIntent("none")}
                  >
                    {executionIntent === "goal" ? (
                      <Target aria-hidden="true" />
                    ) : (
                      <ListChecks aria-hidden="true" />
                    )}
                    <span>
                      {executionIntent === "goal"
                        ? locale === "zh"
                          ? "目标"
                          : "Goal"
                        : locale === "zh"
                          ? "计划"
                          : "Plan"}
                    </span>
                    <X aria-hidden="true" />
                  </button>
                ) : null}
              </>
            }
            disabled={loading}
            id="control-office-message-input"
            palettes={
              <>
                <Palette
                  id="control-office-add-panel"
                  inputId="control-office-add-search"
                  items={visibleAddItems}
                  kind="add"
                  open={openPalette === "add"}
                  placeholder={locale === "zh" ? "添加" : "Add"}
                  query={paletteQuery}
                  onClose={closeComposerPalette}
                  onQueryChange={setPaletteQuery}
                  onSelect={selectAddItem}
                />
                <Palette
                  id="control-office-context-panel"
                  inputId="control-office-context-search"
                  items={visibleContextItems}
                  kind="context"
                  open={openPalette === "context"}
                  placeholder={
                    locale === "zh" ? "搜索知识库或上下文" : "Search context"
                  }
                  query={paletteQuery}
                  onClose={closeComposerPalette}
                  onQueryChange={setPaletteQuery}
                  onSelect={selectContextItem}
                />
                <Palette
                  id="control-office-slash-panel"
                  inputId="control-office-slash-search"
                  items={visibleSlashItems}
                  kind="slash"
                  open={openPalette === "slash"}
                  placeholder={
                    locale === "zh"
                      ? "搜索 Skill 或 MCP"
                      : "Search Skills or MCP"
                  }
                  query={paletteQuery}
                  onClose={closeComposerPalette}
                  onQueryChange={setPaletteQuery}
                  onSelect={selectSlashItem}
                />
              </>
            }
            paletteOpen={Boolean(openPalette)}
            placeholder={
              locale === "zh"
                ? "告诉组长目标、背景或下一步…"
                : "Tell the manager the goal, context, or next step…"
            }
            running={thread?.status.type === "active"}
            sendLabel={locale === "zh" ? "发送" : "Send"}
            slashEnabled
            state={
              isActive ? (
                <span
                  aria-label={locale === "zh" ? "协作中" : "Working"}
                  className="connection-indicator"
                  data-state="connecting"
                  role="status"
                />
              ) : null
            }
            stateId="control-office-composer-status"
            stopLabel={locale === "zh" ? "协作中" : "Working"}
            submitBehavior="enter"
            submitBlocked={!draft.trim()}
            submitting={submitting}
            textareaRef={textareaRef}
            value={draft}
            onChange={setDraft}
            onClosePalette={closeComposerPalette}
            onOpenPalette={openComposerPalette}
            onStop={() => void stopActiveTurn()}
            onSubmit={submitMessage}
          />
          {attachmentError ? (
            <div className="control-office-attachment-error" role="alert">
              {attachmentError}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

export function createControlCommandOfficeRoomAdapter({
  agentSettings,
  client,
  locale,
  runtime,
}: {
  agentSettings?: ControlOfficeMemberAgentSettingsBridge;
  client: ControlOfficeChatClient;
  locale: Locale;
  runtime: ControlOfficeThreadRuntime;
}): CommandOfficeRoomAdapter {
  return {
    open: async (record) => {
      if (!isControlOfficeDefinitionRecord(record)) {
        throw new Error("control_office_record_required");
      }
      await client.getOffice(record.definition.officeVersionId);
    },
    render: (
      record,
      onBack,
      _onDeleted,
      composer = emptyOfficeComposerCapabilities,
    ) =>
      isControlOfficeDefinitionRecord(record) ? (
        <ControlOfficeChatRoom
          agentSettings={agentSettings}
          client={client}
          composer={composer}
          key={officeRecordKey(record)}
          locale={locale}
          onBack={onBack}
          record={record}
          runtime={runtime}
        />
      ) : (
        <div className="team-office-room-error" role="alert">
          {locale === "zh"
            ? "无法打开这个办公室，请返回后重试。"
            : "This Office could not be opened. Go back and try again."}
        </div>
      ),
  };
}
