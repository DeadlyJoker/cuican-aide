import type { AutomationView } from "@crewon/contracts";
import {
  Clock3,
  ExternalLink,
  Info,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AutomationCreateIntent,
  ControlAutomationRuntime,
} from "../../lib/control-runtime/controlAutomationRuntime";
import { CommandAutomationCreateDialog } from "./CommandAutomationCreateDialog";
import { automationErrorMessage } from "./automationErrorMessage";
import { AutomationSkillStatus } from "./AutomationSkillStatus";
import { classNames } from "./commandWorkspaceUtils";
import { CommandScheduleCalendar } from "./CommandScheduleCalendar";
import {
  cadenceLabel,
  formatNextRun,
  isScheduledAutomation,
  nextRunDate,
} from "./automationCalendarModel";
import type { AutomationCreateDraft } from "./automationCreateDraft";

type AutomationAuthorityEpoch = Readonly<{
  controller: AbortController;
  generation: number;
}>;

const runtimeAuthorityIds = new WeakMap<object, number>();
let nextRuntimeAuthorityId = 0;

export function AutomationView({
  active,
  connected,
  controlConfigured,
  createDraft,
  modalOpen,
  runtime,
  selectedThreadId,
  spaceAuthorityKey,
  onCloseModal,
  onOpenModal,
  onOpenThread,
}: {
  active: boolean;
  connected: boolean;
  controlConfigured: boolean;
  createDraft?: AutomationCreateDraft | null;
  modalOpen: boolean;
  runtime: ControlAutomationRuntime | null;
  selectedThreadId: string | null;
  spaceAuthorityKey: string;
  onCloseModal: () => void;
  onOpenModal: () => void;
  onOpenThread?: (threadId: string | null) => void;
}) {
  const authorityKey = JSON.stringify([
    spaceAuthorityKey,
    connected,
    runtime === null ? null : runtimeAuthorityId(runtime),
  ]);

  return (
    <AutomationAuthorityView
      key={authorityKey}
      active={active}
      connected={connected}
      controlConfigured={controlConfigured}
      createDraft={createDraft}
      modalOpen={modalOpen}
      runtime={runtime}
      selectedThreadId={selectedThreadId}
      spaceAuthorityKey={spaceAuthorityKey}
      onCloseModal={onCloseModal}
      onOpenModal={onOpenModal}
      onOpenThread={onOpenThread}
    />
  );
}

function AutomationAuthorityView({
  active,
  connected,
  controlConfigured,
  createDraft,
  modalOpen,
  runtime,
  selectedThreadId,
  spaceAuthorityKey,
  onCloseModal,
  onOpenModal,
  onOpenThread,
}: {
  active: boolean;
  connected: boolean;
  controlConfigured: boolean;
  createDraft?: AutomationCreateDraft | null;
  modalOpen: boolean;
  runtime: ControlAutomationRuntime | null;
  selectedThreadId: string | null;
  spaceAuthorityKey: string;
  onCloseModal: () => void;
  onOpenModal: () => void;
  onOpenThread?: (threadId: string | null) => void;
}) {
  const [definitions, setDefinitions] = useState<readonly AutomationView[]>([]);
  const [query, setQuery] = useState("");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready">(
    "idle",
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const authorityEpochRef = useRef<AutomationAuthorityEpoch | null>(null);

  const refreshForEpoch = useCallback(
    async (
      epoch: AutomationAuthorityEpoch,
      authorityRuntime: ControlAutomationRuntime,
    ) => {
      if (!isCurrentAuthorityEpoch(authorityEpochRef, epoch)) {
        return;
      }
      setLoadState((state) => (state === "idle" ? "loading" : state));
      try {
        const nextDefinitions = await authorityRuntime.listAutomations({
          signal: epoch.controller.signal,
        });
        if (!isCurrentAuthorityEpoch(authorityEpochRef, epoch)) {
          return;
        }
        setDefinitions(nextDefinitions);
        setError(null);
      } catch (nextError) {
        if (!isCurrentAuthorityEpoch(authorityEpochRef, epoch)) {
          return;
        }
        if (
          nextError instanceof DOMException &&
          nextError.name === "AbortError"
        ) {
          return;
        }
        setError("日程加载失败，请稍后重试。");
      } finally {
        if (isCurrentAuthorityEpoch(authorityEpochRef, epoch)) {
          setLoadState("ready");
        }
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    const epoch = authorityEpochRef.current;
    if (
      !connected ||
      runtime === null ||
      epoch === null ||
      !isCurrentAuthorityEpoch(authorityEpochRef, epoch)
    ) {
      return;
    }
    await refreshForEpoch(epoch, runtime);
  }, [connected, refreshForEpoch, runtime]);

  useEffect(() => {
    const previous = authorityEpochRef.current;
    previous?.controller.abort();
    const epoch = createAutomationAuthorityEpoch(
      (previous?.generation ?? 0) + 1,
    );
    authorityEpochRef.current = epoch;
    if (active && connected && runtime !== null) {
      void refreshForEpoch(epoch, runtime);
    }
    return () => {
      epoch.controller.abort();
    };
  }, [active, connected, refreshForEpoch, runtime, spaceAuthorityKey]);

  useEffect(() => {
    if (!active || !connected || runtime === null) return;
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(interval);
  }, [active, connected, refresh, runtime]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = definitions.filter((definition) =>
    `${definition.title} ${definition.prompt}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
  const scheduledDefinitions = visible.filter(isScheduledAutomation);
  const manualDefinitions = visible.filter(
    (definition) => !isScheduledAutomation(definition),
  );
  const nextRun = scheduledDefinitions
    .map(nextRunDate)
    .filter((date): date is Date => date !== null)
    .sort((left, right) => left.getTime() - right.getTime())[0];

  async function createAutomation(intent: AutomationCreateIntent) {
    const epoch = authorityEpochRef.current;
    const authorityRuntime = runtime;
    if (
      authorityRuntime === null ||
      !connected ||
      epoch === null ||
      !isCurrentAuthorityEpoch(authorityEpochRef, epoch) ||
      selectedThreadId === null ||
      intent.threadId !== selectedThreadId
    ) {
      return;
    }
    setBusy("create");
    setNotice(null);
    setError(null);
    try {
      const created = await authorityRuntime.createAutomation(intent, {
        signal: epoch.controller.signal,
      });
      if (!isCurrentAuthorityEpoch(authorityEpochRef, epoch)) {
        return;
      }
      setDefinitions((current) => [
        created,
        ...current.filter(
          (candidate) => candidate.automationId !== created.automationId,
        ),
      ]);
      setNotice(
        `已创建「${created.title}」，将于 ${formatNextRun(nextRunDate(created))} 自动执行。`,
      );
      onCloseModal();
    } catch (nextError) {
      if (!isCurrentAuthorityEpoch(authorityEpochRef, epoch)) {
        return;
      }
      setError(automationErrorMessage(nextError, "创建日程失败，请稍后重试。"));
    } finally {
      if (isCurrentAuthorityEpoch(authorityEpochRef, epoch)) {
        setBusy(null);
      }
    }
  }

  async function runNow(definition: AutomationView) {
    const epoch = authorityEpochRef.current;
    const authorityRuntime = runtime;
    if (
      authorityRuntime === null ||
      !connected ||
      epoch === null ||
      !isCurrentAuthorityEpoch(authorityEpochRef, epoch)
    ) {
      return;
    }
    setBusy(definition.automationId);
    setNotice(null);
    setError(null);
    try {
      const response = await authorityRuntime.runAutomationNow(
        definition.automationId,
        { signal: epoch.controller.signal },
      );
      if (!isCurrentAuthorityEpoch(authorityEpochRef, epoch)) {
        return;
      }
      setNotice(
        `「${definition.title}」已开始执行，结果会保存在绑定的对话中。`,
      );
      onOpenThread?.(response.run.threadId);
    } catch (nextError) {
      if (!isCurrentAuthorityEpoch(authorityEpochRef, epoch)) {
        return;
      }
      if (
        nextError instanceof DOMException &&
        nextError.name === "AbortError"
      ) {
        return;
      }
      await refreshForEpoch(epoch, authorityRuntime);
      if (isCurrentAuthorityEpoch(authorityEpochRef, epoch)) {
        setError(automationErrorMessage(nextError, "执行失败，请稍后重试。"));
      }
    } finally {
      if (isCurrentAuthorityEpoch(authorityEpochRef, epoch)) {
        setBusy(null);
      }
    }
  }

  const unavailableMessage = !controlConfigured
    ? "日程服务暂未配置，配置完成后即可创建和管理日程。"
    : !connected
      ? "正在连接日程服务，连接成功后内容会自动刷新。"
      : null;

  return (
    <section
      className={classNames("shell-view shell-page-view", active && "active")}
      data-shell-view="schedule"
      hidden={!active}
    >
      <div className="page-stack schedule-page">
        <header className="schedule-header" aria-label="日程操作">
          <div className="schedule-header-actions">
            <label className="catalog-search schedule-search">
              <Search aria-hidden="true" />
              <input
                aria-label="搜索日程"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索日程名称或内容"
              />
            </label>
            <button
              className="icon-action schedule-refresh"
              type="button"
              onClick={() => void refresh()}
              disabled={!connected || runtime === null}
              aria-label="刷新日程"
              title="刷新日程"
            >
              <RefreshCw />
            </button>
            <button
              className="button primary"
              type="button"
              onClick={onOpenModal}
              disabled={
                !connected || runtime === null || selectedThreadId === null
              }
            >
              <Plus />
              新建日程
            </button>
          </div>
        </header>

        <section className="schedule-summary" aria-label="日程概览">
          <article>
            <span>全部日程</span>
            <strong>{definitions.length}</strong>
            <small>当前工作空间的安排</small>
          </article>
          <article>
            <span>定时执行</span>
            <strong>{scheduledDefinitions.length}</strong>
            <small>到点自动开始</small>
          </article>
          <article>
            <span>手动执行</span>
            <strong>{manualDefinitions.length}</strong>
            <small>随时可以运行</small>
          </article>
          <article>
            <span>下一次执行</span>
            <strong className="schedule-next-run">
              {formatNextRun(nextRun ?? null)}
            </strong>
            <small>到时自动开始执行</small>
          </article>
        </section>

        {unavailableMessage ? (
          <div className="schedule-notice" role="status">
            <Info />
            {unavailableMessage}
          </div>
        ) : null}
        {error && !modalOpen ? (
          <div className="schedule-alert" role="alert">
            <XCircle />
            {error}
            <button type="button" onClick={() => setError(null)}>
              关闭
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className="schedule-notice" role="status">
            <Info />
            {notice}
            <button type="button" onClick={() => setNotice(null)}>
              关闭
            </button>
          </div>
        ) : null}

        {loadState === "loading" ? (
          <div className="schedule-empty">
            <LoaderCircle className="spin" />
            <p>正在加载日程…</p>
          </div>
        ) : (
          <>
            <CommandScheduleCalendar
              busy={busy}
              definitions={scheduledDefinitions}
              onOpenThread={onOpenThread}
              onRunNow={(definition) => void runNow(definition)}
            />
            {manualDefinitions.length > 0 ? (
              <section className="schedule-manual" aria-label="手动执行的日程">
                <header className="schedule-manual-header">
                  <span>随时手动执行</span>
                  <small>{manualDefinitions.length} 项</small>
                </header>
                <div className="schedule-manual-list">
                  {manualDefinitions.map((definition) => (
                    <article
                      className="schedule-agenda-item"
                      key={definition.automationId}
                    >
                      <div className="schedule-agenda-time">
                        <Clock3 />
                        <strong>{cadenceLabel(definition)}</strong>
                      </div>
                      <div className="schedule-agenda-main">
                        <div className="schedule-agenda-title">
                          <strong>{definition.title}</strong>
                        </div>
                        <p>{definition.prompt}</p>
                        <AutomationSkillStatus definition={definition} />
                      </div>
                      <div className="schedule-agenda-actions">
                        <button
                          className="button compact"
                          type="button"
                          disabled={busy !== null || !connected}
                          onClick={() => void runNow(definition)}
                        >
                          {busy === definition.automationId ? (
                            <LoaderCircle className="spin" />
                          ) : (
                            <Play />
                          )}
                          {definition.skillReadiness?.state === "blocked"
                            ? "重试"
                            : "执行"}
                        </button>
                        <button
                          className="icon-action compact"
                          type="button"
                          aria-label={`打开「${definition.title}」的对话`}
                          onClick={() => onOpenThread?.(definition.threadId)}
                        >
                          <ExternalLink />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>

      {modalOpen ? (
        <CommandAutomationCreateDialog
          key={createDraft?.requestId ?? "new-schedule"}
          busy={busy === "create"}
          connected={connected}
          createDraft={createDraft}
          error={error}
          onClose={onCloseModal}
          onSubmit={createAutomation}
          runtimeAvailable={runtime !== null}
          selectedThreadId={selectedThreadId}
        />
      ) : null}
    </section>
  );
}

export function createAutomationAuthorityEpoch(
  generation: number,
): AutomationAuthorityEpoch {
  return { controller: new AbortController(), generation };
}

export function isCurrentAutomationAuthorityEpoch(
  current: AutomationAuthorityEpoch | null,
  candidate: AutomationAuthorityEpoch,
): boolean {
  return current === candidate && !candidate.controller.signal.aborted;
}

function isCurrentAuthorityEpoch(
  ref: { readonly current: AutomationAuthorityEpoch | null },
  candidate: AutomationAuthorityEpoch,
): boolean {
  return isCurrentAutomationAuthorityEpoch(ref.current, candidate);
}

function runtimeAuthorityId(runtime: object): number {
  const existing = runtimeAuthorityIds.get(runtime);
  if (existing !== undefined) {
    return existing;
  }
  nextRuntimeAuthorityId += 1;
  runtimeAuthorityIds.set(runtime, nextRuntimeAuthorityId);
  return nextRuntimeAuthorityId;
}
