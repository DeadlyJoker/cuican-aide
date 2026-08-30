import type { AutomationSchedule, AutomationView } from "@crewon/contracts";
import {
  CalendarClock,
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
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { ControlAutomationRuntime } from "../../lib/control-runtime/controlAutomationRuntime";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "../shared/ModalDialog";
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
  const [title, setTitle] = useState(
    () => createDraft?.title ?? "每日项目进展摘要",
  );
  const [prompt, setPrompt] = useState(
    () =>
      createDraft?.prompt ??
      "汇总项目进展、关键变化和需要我确认的事项，并给出下一步建议。",
  );
  const [frequency, setFrequency] = useState<
    AutomationSchedule["scheduleType"]
  >(() => createDraft?.frequency ?? "daily");
  const [time, setTime] = useState(() => createDraft?.time ?? "18:00");
  const [weekday, setWeekday] = useState(() => createDraft?.weekday ?? 1);
  const [intervalMinutes, setIntervalMinutes] = useState(
    () => createDraft?.intervalMinutes ?? 60,
  );
  const [runAt, setRunAt] = useState(() =>
    localDateTimeInput(new Date(Date.now() + 60_000)),
  );
  const authorityEpochRef = useRef<AutomationAuthorityEpoch | null>(null);
  const appliedDraftRef = useRef<number | null>(createDraft?.requestId ?? null);

  useEffect(() => {
    if (
      !modalOpen ||
      !createDraft ||
      appliedDraftRef.current === createDraft.requestId
    ) {
      return;
    }
    appliedDraftRef.current = createDraft.requestId;
    setTitle(createDraft.title);
    setPrompt(createDraft.prompt);
    setFrequency(createDraft.frequency);
    if (createDraft.time) setTime(createDraft.time);
    if (createDraft.weekday !== undefined) setWeekday(createDraft.weekday);
    if (createDraft.intervalMinutes !== undefined) {
      setIntervalMinutes(createDraft.intervalMinutes);
    }
  }, [createDraft, modalOpen]);

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

  async function createAutomation(event: FormEvent) {
    event.preventDefault();
    const epoch = authorityEpochRef.current;
    const authorityRuntime = runtime;
    if (
      authorityRuntime === null ||
      !connected ||
      epoch === null ||
      !isCurrentAuthorityEpoch(authorityEpochRef, epoch) ||
      selectedThreadId === null ||
      title.trim().length === 0 ||
      prompt.trim().length === 0
    ) {
      return;
    }
    setBusy("create");
    setNotice(null);
    setError(null);
    try {
      const schedule = createSchedule({
        frequency,
        time,
        weekday,
        intervalMinutes,
        runAt,
      });
      const created = await authorityRuntime.createAutomation(
        {
          threadId: selectedThreadId,
          title: title.trim(),
          prompt: prompt.trim(),
          agentVersionId: null,
          schedule,
        },
        { signal: epoch.controller.signal },
      );
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
      setError(
        nextError instanceof Error &&
          nextError.message === "请选择未来的执行时间"
          ? nextError.message
          : "创建日程失败，请稍后重试。",
      );
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
      setError("执行失败，请稍后重试。");
      await refreshForEpoch(epoch, authorityRuntime);
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
        {error ? (
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
                          执行
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
        <ModalDialog
          busy={busy === "create"}
          closeLabel="关闭"
          description={
            createDraft
              ? "已从助理带入当前请求。确认时间后，到点会自动执行并把结果发回这个对话。"
              : "设定时间和要做的事，到点自动执行，结果保存在绑定的对话里。"
          }
          onClose={onCloseModal}
          title="新建日程"
        >
          <form
            className="grid gap-3.5 schedule-create-modal"
            onSubmit={(event) => void createAutomation(event)}
          >
            <label className="form-field">
              <span>日程名称</span>
              <input
                required
                maxLength={256}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="form-field">
              <span>要完成什么</span>
              <textarea
                required
                rows={5}
                maxLength={9_999}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <label className="form-field">
              <span>执行频率</span>
              <select
                value={frequency}
                onChange={(event) =>
                  setFrequency(
                    event.target.value as AutomationSchedule["scheduleType"],
                  )
                }
              >
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="interval">固定间隔</option>
                <option value="once">执行一次</option>
              </select>
            </label>
            {frequency === "once" ? (
              <label className="form-field">
                <span>执行日期与时间</span>
                <input
                  required
                  type="datetime-local"
                  step={1}
                  value={runAt}
                  onChange={(event) => setRunAt(event.target.value)}
                />
              </label>
            ) : frequency === "interval" ? (
              <label className="form-field">
                <span>间隔（分钟，至少 5 分钟）</span>
                <input
                  required
                  type="number"
                  min={5}
                  max={527_040}
                  value={intervalMinutes}
                  onChange={(event) =>
                    setIntervalMinutes(Number(event.target.value))
                  }
                />
              </label>
            ) : (
              <>
                {frequency === "weekly" ? (
                  <label className="form-field">
                    <span>星期</span>
                    <select
                      value={weekday}
                      onChange={(event) =>
                        setWeekday(Number(event.target.value))
                      }
                    >
                      {[
                        [1, "周一"],
                        [2, "周二"],
                        [3, "周三"],
                        [4, "周四"],
                        [5, "周五"],
                        [6, "周六"],
                        [0, "周日"],
                      ].map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="form-field">
                  <span>执行时间</span>
                  <input
                    required
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                  />
                </label>
              </>
            )}
            <section className="schedule-delivery">
              <CalendarClock />
              <div>
                <strong>绑定当前对话</strong>
                <span>
                  {selectedThreadId !== null
                    ? "执行结果会发送到这个对话，可以随时打开回看。"
                    : "请先选择一个对话，日程的执行结果会保存在那里。"}
                </span>
              </div>
            </section>
            <footer className="arrangement-modal-actions">
              <Button type="button" variant="outline" onClick={onCloseModal}>
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  busy === "create" ||
                  !connected ||
                  runtime === null ||
                  selectedThreadId === null
                }
              >
                {busy === "create" ? (
                  <LoaderCircle className="spin" />
                ) : (
                  <CalendarClock />
                )}
                {busy === "create" ? "创建中…" : "创建并启用"}
              </Button>
            </footer>
          </form>
        </ModalDialog>
      ) : null}
    </section>
  );
}

function createSchedule(input: {
  frequency: AutomationSchedule["scheduleType"];
  time: string;
  weekday: number;
  intervalMinutes: number;
  runAt: string;
}): AutomationSchedule {
  const now = new Date();
  let next: Date;
  if (input.frequency === "once") {
    next = new Date(input.runAt);
  } else if (input.frequency === "interval") {
    const minutes = Math.max(5, Math.floor(input.intervalMinutes));
    next = new Date(now.getTime() + minutes * 60_000);
  } else {
    const [hour, minute] = input.time.split(":").map(Number);
    next = new Date(now);
    next.setHours(hour ?? 0, minute ?? 0, 0, 0);
    if (input.frequency === "weekly") {
      let offset = (input.weekday - now.getDay() + 7) % 7;
      if (offset === 0 && next.getTime() <= now.getTime()) offset = 7;
      next.setDate(next.getDate() + offset);
    } else if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
  }
  if (!Number.isFinite(next.getTime()) || next.getTime() <= now.getTime()) {
    throw new Error("请选择未来的执行时间");
  }
  return {
    scheduleType: input.frequency,
    nextRunAt: next.toISOString(),
    intervalSeconds:
      input.frequency === "weekly"
        ? 7 * 86_400
        : input.frequency === "daily"
          ? 86_400
          : input.frequency === "interval"
            ? Math.max(5, Math.floor(input.intervalMinutes)) * 60
            : 0,
    time: input.frequency === "once" ? localTime(next) : input.time,
    weekday: input.frequency === "weekly" ? input.weekday : next.getDay(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

function localDateTimeInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 19);
}

function localTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
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
