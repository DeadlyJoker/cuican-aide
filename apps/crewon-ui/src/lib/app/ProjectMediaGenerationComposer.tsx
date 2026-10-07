import { Button } from "../../components/ui/button";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ControlApiClient } from "@crewon/control-client";
import type { PublicProjectConversationBinding } from "@crewon/contracts/project-conversations";
import {
  ControlProjectMediaGeneration,
  type ProjectMediaGenerationPresenter,
} from "../control-runtime/controlProjectMediaGeneration";

/** Existing project Composer slot. Uses host controls; never consumes or changes the chat draft. */
export function ProjectMediaGenerationComposer(input: {
  client: ControlApiClient;
  binding: PublicProjectConversationBinding;
  briefRevision: number;
  presenter: ProjectMediaGenerationPresenter;
  busy: boolean;
  zh: boolean;
  onBusyChange(busy: boolean): void;
}) {
  const bindingKey = JSON.stringify(input.binding);
  const owner = useMemo(
    () => ({
      client: input.client,
      presenter: input.presenter,
      bindingKey,
      briefRevision: input.briefRevision,
    }),
    [input.client, input.presenter, bindingKey, input.briefRevision],
  );
  const [instance, setInstance] = useState<{
    owner: typeof owner;
    controller: ControlProjectMediaGeneration;
  } | null>(null);
  useEffect(() => {
    const controller = new ControlProjectMediaGeneration({
      client: owner.client,
      presenter: owner.presenter,
      binding: JSON.parse(owner.bindingKey),
      briefRevision: owner.briefRevision,
    });
    setInstance({ owner, controller });
    void controller.refresh();
    return () => controller.dispose();
  }, [owner]);
  return instance?.owner === owner ? (
    <GenerationControls
      controller={instance.controller}
      busy={input.busy}
      zh={input.zh}
      onBusyChange={input.onBusyChange}
    />
  ) : null;
}

function GenerationControls({
  controller,
  busy,
  zh,
  onBusyChange,
}: {
  controller: ControlProjectMediaGeneration;
  busy: boolean;
  zh: boolean;
  onBusyChange(busy: boolean): void;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const preparing =
    state.operation === "preparing" || state.operation === "adopting";
  useEffect(() => {
    onBusyChange(preparing);
    return () => onBusyChange(false);
  }, [preparing, onBusyChange]);
  if (state.phase === "loading" || state.phase === "unavailable") return null;
  const working = state.operation !== "idle";
  const messages = {
    "none": "",
    "refused": zh
      ? "已确认原请求尚未创建任务。检查输入后，可明确重新生成。"
      : "The original request created no task. Check the input before generating again.",
    "unknown": zh
      ? "原请求结果待确认。恢复只读取记录；重试使用原请求号。"
      : "The original request needs recovery. Reads do not generate; retry keeps its original key.",
    "accepted": zh
      ? "任务已进入当前项目会话。"
      : "Task accepted in this project conversation.",
    "read-failed": zh
      ? "生成状态暂不可用，请刷新。"
      : "Generation state unavailable. Refresh to recover.",
    "adoption-failed": zh
      ? "任务已受理，展示尚未恢复。点击查看原任务，不会重新生成。"
      : "Task accepted. Open the original task to restore its display without generating again.",
    "stale": zh
      ? "输入来源已变化，请先在工作台确认新版本。"
      : "Input sources changed. Confirm a new version in the workbench.",
  };
  const selected = state.selected?.input;
  return (
    <details
      style={{
        display: "block",
        flex: "1 1 100%",
        minWidth: 0,
        maxWidth: "100%",
        maxHeight: "35vh",
        overflowY: "auto",
        whiteSpace: "normal",
        textAlign: "left",
        overflowWrap: "anywhere",
      }}
      className="composer-state"
      aria-label={zh ? "生成已保存画面" : "Generate saved media"}
    >
      <summary className="cursor-pointer py-2 text-left text-foreground">
        {zh ? "生成已保存画面" : "Generate saved media"}
      </summary>
      <span>
        {zh
          ? "使用已保存的画面描述与参考素材；聊天草稿保持不变。"
          : "Uses saved prompts and references; your chat draft stays unchanged."}
      </span>{" "}
      <select
        className="h-8 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        aria-label={zh ? "已保存画面输入" : "Saved media input"}
        style={{ maxWidth: "100%" }}
        value={selected?.mediaInputId ?? ""}
        disabled={busy || working || controller.locked}
        onChange={(e) => {
          void controller.select(e.target.value);
        }}
      >
        <option value="">
          {zh ? "选择已保存输入" : "Select a saved input"}
        </option>
        {selected &&
        !state.inputs.some(
          (entry) => entry.mediaInputId === selected.mediaInputId,
        ) ? (
          <option value={selected.mediaInputId}>
            {zh ? "已选输入" : "Selected input"} · v{selected.inputRevision}
          </option>
        ) : null}
        {state.inputs.map((entry, i) => (
          <option key={entry.mediaInputId} value={entry.mediaInputId}>
            {entry.workflowId === "krea2-reference-four-view"
              ? zh
                ? "角色四视图"
                : "Character views"
              : zh
                ? "分镜探索"
                : "Frame exploration"}{" "}
            · {zh ? "输入" : "Input"} {i + 1} · v
            {entry.mediaInputId === selected?.mediaInputId
              ? selected.inputRevision
              : entry.latestInputRevision}
          </option>
        ))}
      </select>{" "}
      {selected ? (
        <span
          style={{
            display: "block",
            maxHeight: 72,
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
          aria-label={zh ? "本次画面描述" : "Saved prompt"}
        >
          {selected.prompt}
        </span>
      ) : null}{" "}
      {selected && !controller.canGenerate && !controller.locked && !working ? (
        <span role="status">
          {zh
            ? "输入或执行配置已变化，请刷新或在工作台确认。"
            : "Input or execution configuration changed. Refresh or confirm in the workbench."}
        </span>
      ) : null}
      {state.inputs.length === 0 ? (
        <span>
          {zh
            ? "先让 Agent 准备输入，或在短剧工作台保存输入。"
            : "Ask the Agent to prepare input, or save it in the workbench."}
        </span>
      ) : null}
      {state.foreignPending ? (
        <span role="status">
          {zh
            ? "其他项目会话有未确认的生成请求，请先回到原会话恢复。"
            : "Another project conversation has an unresolved generation request. Recover it there first."}
        </span>
      ) : null}
      {state.notice !== "none" ? (
        <span role="status">{messages[state.notice]}</span>
      ) : null}{" "}
      {preparing ? (
        <Button
          size="sm"
          variant="outline"
          type="button"
          onClick={() => controller.stopWaiting()}
        >
          {zh ? "停止等待" : "Stop waiting"}
        </Button>
      ) : (
        <>
          <Button
            size="sm"
            variant="secondary"
            type="button"
            disabled={busy || !controller.canGenerate}
            onClick={() => {
              void controller.generate();
            }}
          >
            {state.receipt
              ? zh
                ? "再次生成画面"
                : "Generate again"
              : zh
                ? "生成画面"
                : "Generate"}
          </Button>{" "}
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={busy || working}
            onClick={() => {
              void controller.refresh();
            }}
          >
            {zh ? "刷新输入与恢复状态" : "Refresh inputs and recovery"}
          </Button>{" "}
          {controller.locked && !state.foreignPending ? (
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={busy || working || !state.retryable}
              onClick={() => {
                void controller.retry();
              }}
            >
              {zh ? "用原请求重试" : "Retry original request"}
            </Button>
          ) : null}
          {state.receipt ? (
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={busy || working}
              onClick={() => {
                void controller.showTask();
              }}
            >
              {zh ? "查看原任务" : "Open original task"}
            </Button>
          ) : null}
          {state.next !== null ? (
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={busy || working || controller.locked}
              onClick={() => {
                void controller.nextPage();
              }}
            >
              {zh ? "下一页输入" : "Next input page"}
            </Button>
          ) : null}
        </>
      )}
    </details>
  );
}
