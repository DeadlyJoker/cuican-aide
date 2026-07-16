import { Plus, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CommandComposer } from "../composer/CommandComposer";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { OfficeMember } from "../../lib/domain/crewonDomain";
import type {
  OfficeMessageSubmitMention,
  PendingOfficeMessageDelivery,
} from "../../lib/domain/officeMessageDelivery";
import type { Locale } from "../../lib/i18n";
import type { OfficeComposerRuntimeMode } from "../../lib/office/officeComposerRuntime";
import {
  officeMessageDraftMentionForMember,
  officeMessageMentionsForSubmission,
  type OfficeMessageDraftMention,
} from "../../lib/office/officeMessageMentions";

export const OFFICE_COMPOSER_INPUT_LIMIT_BYTES = 900;

export function officeComposerInputState(value: string, locale: Locale) {
  const bytes = new TextEncoder().encode(value.trim()).byteLength;
  const overLimit = bytes > OFFICE_COMPOSER_INPUT_LIMIT_BYTES;
  return {
    bytes,
    counter: `${bytes}/${OFFICE_COMPOSER_INPUT_LIMIT_BYTES} ${locale === "zh" ? "字节" : "bytes"}`,
    overLimit,
    status: overLimit
      ? locale === "zh"
        ? `消息超过 ${OFFICE_COMPOSER_INPUT_LIMIT_BYTES} 字节，请缩短后发送`
        : `Message exceeds ${OFFICE_COMPOSER_INPUT_LIMIT_BYTES} bytes; shorten it before sending`
      : null,
  };
}

export function officeComposerCopy(
  mode: OfficeComposerRuntimeMode,
  locale: Locale,
) {
  const zh = locale === "zh";
  switch (mode) {
    case "managerConversationActive":
      return {
        placeholder: zh
          ? "继续群聊；明确提出工作时会原地升级为任务…"
          : "Continue the conversation; explicit work upgrades it to a task…",
        sendLabel: zh ? "继续对话" : "Continue chat",
        status: zh
          ? "主控回复中 · 普通消息继续对话，明确工作才进入任务"
          : "Manager replying · chat stays conversational until work is explicit",
      };
    case "managerActive":
      return {
        placeholder: zh
          ? "追加要求；主控会在当前任务中继续处理…"
          : "Add a requirement for the manager's current task…",
        sendLabel: zh ? "追加要求" : "Add requirement",
        status: zh
          ? "主控执行中 · 发送将追加要求"
          : "Manager running · send adds a requirement",
      };
    case "childActive":
      return {
        placeholder: zh
          ? "补充要求会先交给主控，并在成员任务间安全排队…"
          : "Send context to the manager to queue safely around member work…",
        sendLabel: zh ? "交给主控" : "Send to manager",
        status: zh
          ? "成员执行中 · 新消息由主控排队处理"
          : "Members running · the manager will queue new messages",
      };
    case "canceling":
      return {
        placeholder: zh
          ? "当前任务正在停止；新消息会排队等待安全处理…"
          : "The current task is stopping; new messages will queue safely…",
        sendLabel: zh ? "排队消息" : "Queue message",
        status: zh
          ? "正在停止 · 新消息将排队"
          : "Stopping · new messages will be queued",
      };
    case "queued":
      return {
        placeholder: zh
          ? "已有工作在处理；继续发送会由服务端按顺序排队…"
          : "Work is already in progress; the server will queue this in order…",
        sendLabel: zh ? "继续排队" : "Queue next",
        status: zh
          ? "已有工作排队 · 服务端决定下一步"
          : "Work queued · the server owns the next action",
      };
    case "idle":
      return {
        placeholder: zh
          ? "告诉组长目标、背景或下一步…"
          : "Tell the manager agent the goal, context, or next step…",
        sendLabel: zh ? "发送" : "Send",
        status: zh
          ? "已就绪 · 可继续编辑或发送"
          : "Ready · continue editing or send",
      };
  }
}

export function insertOfficeMemberMention(
  value: string,
  memberName: string,
  start: number,
  end: number,
) {
  const before = value.slice(0, start);
  const mention = `${before && !/\s$/.test(before) ? " " : ""}@${memberName.trim()} `;
  return {
    caret: before.length + mention.length,
    value: `${before}${mention}${value.slice(end)}`,
  };
}

export function insertOfficeSlashCommand(
  value: string,
  token: string,
  start: number,
  end: number,
) {
  const before = value.slice(0, start);
  const command = `${before && !/\s$/.test(before) ? " " : ""}/${token.trim()} `;
  return {
    caret: before.length + command.length,
    value: `${before}${command}${value.slice(end)}`,
  };
}

export function insertOfficeAttachmentReference(
  value: string,
  path: string,
  start: number,
  end: number,
) {
  const before = value.slice(0, start);
  const reference = `${before && !/\s$/.test(before) ? " " : ""}附件：${path.trim()} `;
  return {
    caret: before.length + reference.length,
    value: `${before}${reference}${value.slice(end)}`,
  };
}

export function OfficeComposer({
  draft,
  isSubmitting,
  isStopping,
  locale,
  members,
  onDraftChange,
  onAttachContext,
  onStop,
  onSubmit,
  pendingDelivery,
  runtimeMode,
  slashCommands = [],
}: {
  draft: string;
  isSubmitting: boolean;
  isStopping: boolean;
  locale: Locale;
  members: OfficeMember[];
  onDraftChange: (draft: string) => void;
  onAttachContext?: (onSelectPath: (path: string) => void) => void;
  onStop?: () => void | Promise<void>;
  onSubmit: (
    draft: string,
    mentions: OfficeMessageSubmitMention[],
  ) => void | Promise<void>;
  pendingDelivery: PendingOfficeMessageDelivery | null;
  runtimeMode: OfficeComposerRuntimeMode;
  slashCommands?: ComposerSlashCommand[];
}) {
  const [openPalette, setOpenPalette] = useState<
    "members" | "slash" | null
  >(null);
  const [selectedMentions, setSelectedMentions] = useState<
    OfficeMessageDraftMention[]
  >([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!openPalette) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenPalette(null);
      }
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [openPalette]);

  useEffect(() => {
    if (!draft.trim()) {
      setSelectedMentions([]);
      return;
    }
    const currentMemberIds = new Set(
      members.flatMap((member) => {
        const memberId = member.memberId?.trim();
        return memberId ? [memberId] : [];
      }),
    );
    setSelectedMentions((current) => {
      const next = current.filter((mention) =>
        currentMemberIds.has(mention.memberId),
      );
      return next.length === current.length ? current : next;
    });
  }, [draft, members]);

  function closePalette() {
    setOpenPalette(null);
    textareaRef.current?.focus();
  }

  function insertMember(member: OfficeMember) {
    const selected = officeMessageDraftMentionForMember(member, members);
    if (!selected) {
      return;
    }
    const textarea = textareaRef.current;
    const result = insertOfficeMemberMention(
      draft,
      selected.displayText.slice(1),
      textarea?.selectionStart ?? draft.length,
      textarea?.selectionEnd ?? draft.length,
    );
    setSelectedMentions((current) =>
      current.some((mention) => mention.memberId === selected.memberId)
        ? current
        : [...current, selected],
    );
    onDraftChange(result.value);
    closePalette();
    requestAnimationFrame(() =>
      textareaRef.current?.setSelectionRange(result.caret, result.caret),
    );
  }

  function insertSlashCommand(command: ComposerSlashCommand) {
    const textarea = textareaRef.current;
    const result = insertOfficeSlashCommand(
      draft,
      command.token,
      textarea?.selectionStart ?? draft.length,
      textarea?.selectionEnd ?? draft.length,
    );
    onDraftChange(result.value);
    closePalette();
    requestAnimationFrame(() =>
      textareaRef.current?.setSelectionRange(result.caret, result.caret),
    );
  }

  function attachContext() {
    if (!onAttachContext) return;
    const selectionStart = textareaRef.current?.selectionStart ?? draft.length;
    const selectionEnd = textareaRef.current?.selectionEnd ?? draft.length;
    onAttachContext((path) => {
      const result = insertOfficeAttachmentReference(
        draft,
        path,
        selectionStart,
        selectionEnd,
      );
      onDraftChange(result.value);
      requestAnimationFrame(() =>
        textareaRef.current?.setSelectionRange(result.caret, result.caret),
      );
    });
  }

  const zh = locale === "zh";
  const copy = pendingDelivery
    ? officePendingDeliveryCopy(pendingDelivery, locale)
    : officeComposerCopy(runtimeMode, locale);
  const canStop = Boolean(onStop);
  const draftLocked = Boolean(pendingDelivery);
  const inputState = officeComposerInputState(draft, locale);
  const resolvedMentions = officeMessageMentionsForSubmission(
    draft,
    members,
    selectedMentions,
  );
  const routedMemberNames = resolvedMentions.flatMap(({ memberId }) => {
    const selected = selectedMentions.find(
      (mention) => mention.memberId === memberId,
    );
    if (selected) {
      return [selected.displayText];
    }
    const member = members.find((candidate) => candidate.memberId === memberId);
    return member ? [`@${member.name}`] : [];
  });
  const routingCopy =
    routedMemberNames.length > 0
      ? zh
        ? `群聊公开 · 定向 ${routedMemberNames.join("、")}`
        : `Visible to the room · directed to ${routedMemberNames.join(", ")}`
      : zh
        ? "群聊公开 · 未 @ 时由主控接收"
        : "Visible to the room · manager receives messages without @mentions";
  const capabilityHint =
    routedMemberNames.length > 0
      ? routingCopy
      : zh
        ? "未 @ 时由办公室主控接收 · 输入 @ 选择员工，/ 使用 Skill 或 MCP"
        : "Office manager receives messages without @ · type @ for members or / for Skill and MCP";
  const availableSlashCommands = slashCommands.filter(
    (command) => command.kind === "skill" || command.kind === "mcp",
  );
  const visibleStatus =
    pendingDelivery || runtimeMode !== "idle" ? copy.status : capabilityHint;
  return (
    <div
      className="office-shared-composer-shell"
      data-runtime-mode={runtimeMode}
      ref={rootRef}
    >
      <CommandComposer
        actions={
          canStop ? (
            <button
              aria-busy={isStopping}
              aria-label={zh ? "停止当前办公室任务" : "Stop current Office run"}
              className="office-stop-button"
              disabled={isStopping || runtimeMode === "canceling"}
              title={zh ? "停止当前任务" : "Stop current run"}
              type="button"
              onClick={() => void onStop?.()}
            >
              <Square aria-hidden="true" />
              <span>
                {isStopping || runtimeMode === "canceling"
                  ? zh
                    ? "停止中"
                    : "Stopping"
                  : zh
                    ? "停止"
                    : "Stop"}
              </span>
            </button>
          ) : null
        }
        ariaDescribedBy="office-composer-status office-composer-budget"
        ariaInvalid={inputState.overLimit}
        ariaLabel={zh ? "群聊输入" : "Group chat input"}
        className="command-input office-global-composer office-shared-composer"
        controls={
          <button
            aria-label={zh ? "添加附件" : "Add attachment"}
            className="icon-action composer-plus-action office-composer-attach-action"
            disabled={draftLocked || !onAttachContext}
            title={zh ? "添加工作空间附件" : "Add workspace attachment"}
            type="button"
            onClick={attachContext}
          >
            <Plus aria-hidden="true" />
          </button>
        }
        disabled={isSubmitting}
        id="office-message-input"
        maxHeight={112}
        palettes={
          <>
            <div
              className="context-palette office-member-palette"
              data-composer-palette=""
              hidden={openPalette !== "members"}
            >
              <div className="context-list" role="listbox">
                {members.map((member) => {
                  const mention = officeMessageDraftMentionForMember(
                    member,
                    members,
                  );
                  return (
                    <button
                      disabled={!mention}
                      key={member.memberId ?? member.agentId ?? member.name}
                      role="option"
                      title={
                        mention
                          ? mention.displayText
                          : zh
                            ? "该成员尚无可路由的 memberId"
                            : "This member does not have a routable memberId yet"
                      }
                      type="button"
                      onClick={() => insertMember(member)}
                    >
                      <span>{member.glyph}</span>
                      <strong>{member.name}</strong>
                      <em>{member.role}</em>
                    </button>
                  );
                })}
              </div>
            </div>
            <div
              className="slash-palette office-slash-palette"
              data-composer-palette=""
              hidden={openPalette !== "slash"}
            >
              <div className="slash-list" role="listbox">
                {availableSlashCommands.length > 0 ? (
                  availableSlashCommands.map((command) => (
                    <button
                      key={command.id}
                      role="option"
                      title={command.description}
                      type="button"
                      onClick={() => insertSlashCommand(command)}
                    >
                      <span>{command.meta}</span>
                      <strong>{command.label}</strong>
                      <em>{command.description}</em>
                    </button>
                  ))
                ) : (
                  <p className="office-composer-palette-empty">
                    {zh
                      ? "当前没有可用的 Skill 或 MCP。"
                      : "No Skill or MCP capability is currently available."}
                  </p>
                )}
              </div>
            </div>
          </>
        }
        paletteOpen={Boolean(openPalette)}
        placeholder={copy.placeholder}
        readOnly={draftLocked}
        sendLabel={copy.sendLabel}
        slashEnabled
        state={
          <>
            <span
              aria-live="polite"
              className="composer-state"
              id="office-composer-status"
              role="status"
            >
              {isSubmitting
                ? zh
                  ? "办公室 · 发送中"
                  : "Office · sending"
                : (inputState.status ?? visibleStatus)}
            </span>
            <span
              className="composer-input-budget"
              data-over-limit={inputState.overLimit || undefined}
              id="office-composer-budget"
            >
              {inputState.counter}
            </span>
          </>
        }
        submitBehavior="enter"
        submitBlocked={inputState.overLimit}
        submitting={isSubmitting}
        textareaRef={textareaRef}
        value={draft}
        onChange={onDraftChange}
        onClosePalette={closePalette}
        onOpenPalette={(intent) => {
          const next = intent === "context" ? "members" : "slash";
          setOpenPalette((current) => (current === next ? null : next));
        }}
        onSubmit={(value) => onSubmit(value, resolvedMentions)}
      />
    </div>
  );
}

export function officePendingDeliveryCopy(
  delivery: PendingOfficeMessageDelivery,
  locale: Locale,
) {
  const zh = locale === "zh";
  if (delivery.type === "queued") {
    return {
      placeholder: zh
        ? "消息已排队；再次发送会用同一回执重试…"
        : "Message queued; send again to retry the same receipt…",
      sendLabel: zh ? "重试排队消息" : "Retry queued message",
      status: zh
        ? `已排队 · 第 ${delivery.position} 位 · 保留同一回执`
        : `Queued · position ${delivery.position} · same receipt retained`,
    };
  }
  return {
    placeholder: zh
      ? "消息处理中；再次发送会用同一回执查询并重试…"
      : "Message processing; send again to query and retry the same receipt…",
    sendLabel: zh ? "重试处理中消息" : "Retry processing message",
    status: zh
      ? `处理中 · ${officeProcessingPhaseLabel(delivery.phase, locale)} · 保留同一回执`
      : `Processing · ${officeProcessingPhaseLabel(delivery.phase, locale)} · same receipt retained`,
  };
}

function officeProcessingPhaseLabel(
  phase: Extract<PendingOfficeMessageDelivery, { type: "processing" }>["phase"],
  locale: Locale,
) {
  if (locale === "en") return phase;
  switch (phase) {
    case "reserved":
      return "已保留";
    case "dispatching":
      return "派发中";
    case "recovering":
      return "恢复中";
  }
}
