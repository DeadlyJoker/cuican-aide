import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  ExternalLink,
  History,
  Inbox,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { CommandScheduleCalendar } from "./CommandScheduleCalendar";
import type { ScheduleRecord } from "./scheduleCalendarModel";
import { classNames } from "./commandWorkspaceUtils";
import type { AutomationConfig } from "../../lib/domain/crewonDomain";

export type { ScheduleRecord } from "./scheduleCalendarModel";

type AutomationRunRecord = {
  runId: string;
  automationTitle: string;
  threadId: string | null;
  turnId: string | null;
  status: string;
  startedAt: number;
  completedAt: number | null;
  note: string | null;
  config: AutomationConfig;
};

type RunRecord = {
  filePath: string;
  savedAt: number;
  run: AutomationRunRecord;
};

export type ScheduleClient = {
  createAutomationConfig(
    cwd: string,
    params: {
      title: string;
      threadId?: string | null;
      prompt?: string | null;
      enabled?: boolean | null;
      status?: string | null;
    },
  ): Promise<{ filePath: string; config: AutomationConfig }>;
  listAutomationConfigs(cwd: string): Promise<{ data: ScheduleRecord[] }>;
  listAutomationRuns(
    cwd: string,
    threadId?: string | null,
    limit?: number,
  ): Promise<{ data: RunRecord[] }>;
  renameThread(threadId: string, name: string): Promise<void>;
  startAutomationRunConfig(
    cwd: string,
    config: AutomationConfig,
    params?: { note?: string | null; locale?: string | null },
  ): Promise<unknown>;
  startThread(cwd?: string, threadSource?: string): Promise<{ id: string }>;
  updateAutomationConfig(
    cwd: string,
    filePath: string,
    config: AutomationConfig,
  ): Promise<unknown>;
};

type Frequency = "daily" | "weekly" | "interval" | "once";

const defaultPrompt =
  "汇总项目进展、关键变化、阻塞和需要我确认的事项，并给出下一步建议。";

function timestampForLocalTime(
  time: string,
  dayOffset = 0,
  baseDate = new Date(),
) {
  const [hour, minute] = time.split(":").map(Number);
  const date = new Date(baseDate);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour || 0, minute || 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

export function nextScheduledAt(
  frequency: Frequency,
  params: {
    time: string;
    weekday: number;
    intervalMinutes: number;
    runAt: string;
  },
  now = new Date(),
) {
  if (frequency === "interval") {
    return (
      Math.floor(now.getTime() / 1000) +
      Math.max(1, params.intervalMinutes) * 60
    );
  }
  if (frequency === "once") {
    return Math.floor(new Date(params.runAt).getTime() / 1000);
  }
  if (frequency === "weekly") {
    const today = now.getDay();
    let offset = (params.weekday - today + 7) % 7;
    const candidate = timestampForLocalTime(params.time, offset, now);
    if (candidate <= Math.floor(now.getTime() / 1000)) offset += 7;
    return timestampForLocalTime(params.time, offset, now);
  }
  const candidate = timestampForLocalTime(params.time, 0, now);
  return candidate > Math.floor(now.getTime() / 1000)
    ? candidate
    : timestampForLocalTime(params.time, 1, now);
}

function formatDateTime(timestamp?: number | null) {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp * 1000);
}

function runStatus(status: string) {
  if (status === "completed")
    return { label: "已完成", tone: "success", icon: CheckCircle2 };
  if (status === "running")
    return { label: "执行中", tone: "running", icon: LoaderCircle };
  if (status === "failed")
    return { label: "失败", tone: "danger", icon: XCircle };
  if (status === "interrupted")
    return { label: "已中断", tone: "warn", icon: XCircle };
  return { label: status, tone: "neutral", icon: Clock3 };
}

export function ScheduleView({
  active,
  client,
  cwd,
  modalOpen,
  scheduleMode,
  scheduleSource,
  onCloseModal,
  onModeChange,
  onOpenModal,
  onOpenThread,
  onSourceChange,
}: {
  active: boolean;
  client?: ScheduleClient | null;
  cwd: string;
  modalOpen: boolean;
  scheduleMode: string;
  scheduleSource: string;
  onCloseModal: () => void;
  onModeChange: (mode: string) => void;
  onOpenModal: () => void;
  onOpenThread?: (threadId: string | null) => void;
  onSourceChange: (source: string) => void;
}) {
  const [records, setRecords] = useState<ScheduleRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [query, setQuery] = useState("");
  const [runFilter, setRunFilter] = useState("all");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [title, setTitle] = useState("每日项目进展摘要");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [time, setTime] = useState("18:00");
  const [weekday, setWeekday] = useState(1);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [runAt, setRunAt] = useState("");

  const refresh = useCallback(async () => {
    if (!client || !cwd) return;
    setLoadState((state) => (state === "idle" ? "loading" : state));
    try {
      const [configResponse, runResponse] = await Promise.all([
        client.listAutomationConfigs(cwd),
        client.listAutomationRuns(cwd, null, 100),
      ]);
      setRecords(
        configResponse.data.filter(({ config }) => config.scope !== "team"),
      );
      setRuns(
        runResponse.data.filter(({ run }) => run.config.scope !== "team"),
      );
      setError(null);
      setLoadState("ready");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "加载日程失败");
      setLoadState("ready");
    }
  }, [client, cwd]);

  useEffect(() => {
    if (!active || scheduleSource !== "personal") return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(interval);
  }, [active, refresh, scheduleSource]);

  const visibleRecords = records.filter(({ config }) =>
    `${config.title} ${config.body} ${config.prompt}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const visibleRuns = runs.filter(({ run }) => {
    const matchesQuery = `${run.automationTitle} ${run.note ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
    return matchesQuery && (runFilter === "all" || run.status === runFilter);
  });
  const enabledCount = records.filter(({ config }) => config.enabled).length;
  const runningCount = runs.filter(
    ({ run }) => run.status === "running",
  ).length;
  const failedCount = runs.filter(({ run }) => run.status === "failed").length;
  const nextRun = records
    .filter(({ config }) => config.enabled)
    .map(({ config }) => Number(config.trigger?.nextRunAt ?? 0))
    .filter(Boolean)
    .sort((a, b) => a - b)[0];

  async function createSchedule(event: FormEvent) {
    event.preventDefault();
    if (!client || !title.trim() || !prompt.trim()) return;
    const nextRunAt = nextScheduledAt(frequency, {
      time,
      weekday,
      intervalMinutes,
      runAt,
    });
    if (
      !Number.isFinite(nextRunAt) ||
      nextRunAt <= Math.floor(Date.now() / 1000)
    ) {
      setError("请选择未来的执行时间");
      return;
    }
    setBusy("create");
    try {
      const thread = await client.startThread(cwd, "automation");
      await client.renameThread(thread.id, `[日程] ${title.trim()}`);
      const created = await client.createAutomationConfig(cwd, {
        title: title.trim(),
        threadId: thread.id,
        prompt: prompt.trim(),
        enabled: true,
        status: "enabled",
      });
      const intervalSeconds =
        frequency === "weekly"
          ? 7 * 86_400
          : frequency === "daily"
            ? 86_400
            : frequency === "interval"
              ? Math.max(1, intervalMinutes) * 60
              : 0;
      await client.updateAutomationConfig(cwd, created.filePath, {
        ...created.config,
        scope: "personal",
        subtitle: "按计划自动执行",
        body: "结果发送给我，并保存在 CrewON 结果线程。",
        trigger: {
          type: "schedule",
          scheduleType: frequency,
          nextRunAt,
          intervalSeconds,
          intervalMinutes,
          time,
          weekday,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
        },
        delivery: {
          destination: "scheduleCenter",
          recipient: "owner",
          recipientLabel: "我（创建者）",
          notifyOn: "always",
        },
      });
      onCloseModal();
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "创建日程失败");
    } finally {
      setBusy(null);
    }
  }

  async function runNow(record: ScheduleRecord) {
    if (!client) return;
    setBusy(record.filePath);
    try {
      await client.startAutomationRunConfig(cwd, record.config, {
        locale: "zh-CN",
        note: "手动执行",
      });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "执行日程失败");
    } finally {
      setBusy(null);
    }
  }

  async function toggleSchedule(record: ScheduleRecord) {
    if (!client) return;
    setBusy(record.filePath);
    try {
      const enabled = !record.config.enabled;
      await client.updateAutomationConfig(cwd, record.filePath, {
        ...record.config,
        enabled,
        status: enabled ? "enabled" : "disabled",
      });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "更新日程失败");
    } finally {
      setBusy(null);
    }
  }

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
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索日程或执行记录"
              />
            </label>
            <button
              className="icon-action schedule-refresh"
              type="button"
              onClick={() => void refresh()}
              disabled={!client}
              aria-label="刷新日程"
              title="刷新日程"
            >
              <RefreshCw />
            </button>
            <button
              className="button primary"
              type="button"
              onClick={onOpenModal}
              disabled={!client || scheduleSource !== "personal"}
            >
              <Plus />
              新建日程
            </button>
          </div>
        </header>

        <nav className="schedule-subnav" aria-label="日程筛选">
          <div
            className="schedule-scope-tabs"
            role="group"
            aria-label="日程范围"
          >
            <button
              className={scheduleSource === "personal" ? "active" : ""}
              onClick={() => onSourceChange("personal")}
              type="button"
            >
              个人日程
            </button>
            <button
              className={scheduleSource === "teamflow" ? "active" : ""}
              onClick={() => onSourceChange("teamflow")}
              type="button"
            >
              小队日程
            </button>
          </div>
          <span className="schedule-nav-divider" aria-hidden="true" />
          <div
            className="schedule-view-tabs"
            role="group"
            aria-label="查看内容"
          >
            <button
              className={scheduleMode === "tasks" ? "active" : ""}
              onClick={() => onModeChange("tasks")}
              type="button"
            >
              日程
            </button>
            <button
              className={scheduleMode === "history" ? "active" : ""}
              onClick={() => onModeChange("history")}
              type="button"
            >
              执行记录
            </button>
          </div>
          {scheduleSource === "personal" ? (
            <span className="schedule-delivery-note">
              <Inbox />
              结果发送给：我（创建者） · 保存在个人日程中心
            </span>
          ) : null}
        </nav>

        {scheduleSource === "teamflow" ? (
          <div className="schedule-empty">
            <CalendarClock />
            <h3>小队日程将在小队工作流中配置</h3>
            <p>
              个人日程只服务于你自己；小队日程还需要明确负责人、结果共享与权限规则。
            </p>
          </div>
        ) : (
          <>
            <section className="schedule-summary" aria-label="日程概览">
              <article>
                <span>已启用</span>
                <strong>{enabledCount}</strong>
                <small>按计划自动执行</small>
              </article>
              <article>
                <span>执行中</span>
                <strong>{runningCount}</strong>
                <small>同一日程不会重叠</small>
              </article>
              <article>
                <span>失败</span>
                <strong>{failedCount}</strong>
                <small>可在记录中追踪</small>
              </article>
              <article>
                <span>下一次执行</span>
                <strong className="schedule-next-run">
                  {formatDateTime(nextRun)}
                </strong>
                <small>到时自动开始执行</small>
              </article>
            </section>

            {error ? (
              <div className="schedule-alert" role="alert">
                <XCircle />
                {error}
                <button type="button" onClick={() => setError(null)}>
                  关闭
                </button>
              </div>
            ) : null}
            {!client ? (
              <div className="schedule-alert" role="status">
                App Server 未连接，连接后可管理个人日程。
              </div>
            ) : null}

            {scheduleMode === "tasks" ? (
              loadState === "loading" ? (
                <div className="schedule-empty">
                  <LoaderCircle className="spin" />
                  <p>正在加载日程…</p>
                </div>
              ) : (
                <CommandScheduleCalendar
                  busy={busy}
                  clientAvailable={Boolean(client)}
                  records={visibleRecords}
                  onCreate={onOpenModal}
                  onOpenThread={onOpenThread}
                  onRunNow={(record) => void runNow(record)}
                  onToggleSchedule={(record) => void toggleSchedule(record)}
                />
              )
            ) : (
              <section className="schedule-history" aria-label="执行记录">
                <div className="schedule-history-filters">
                  {[
                    ["all", "全部"],
                    ["running", "执行中"],
                    ["completed", "已完成"],
                    ["failed", "失败"],
                  ].map(([value, label]) => (
                    <button
                      className={runFilter === value ? "active" : ""}
                      type="button"
                      onClick={() => setRunFilter(value)}
                      key={value}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="schedule-run-table" role="table">
                  <div className="schedule-run-row header" role="row">
                    <span>日程 / 触发方式</span>
                    <span>开始时间</span>
                    <span>耗时</span>
                    <span>发送给</span>
                    <span>状态</span>
                    <span>结果</span>
                  </div>
                  {visibleRuns.map(({ filePath, run }) => {
                    const status = runStatus(run.status);
                    const Icon = status.icon;
                    const duration = run.completedAt
                      ? `${Math.max(0, run.completedAt - run.startedAt)} 秒`
                      : "—";
                    return (
                      <div
                        className="schedule-run-row"
                        role="row"
                        key={filePath}
                      >
                        <span>
                          <strong>{run.automationTitle}</strong>
                          <small>{run.note ?? "按计划执行"}</small>
                        </span>
                        <span>{formatDateTime(run.startedAt)}</span>
                        <span>{duration}</span>
                        <span>我 · 个人日程</span>
                        <span>
                          <em className={`run-${status.tone}`}>
                            <Icon
                              className={
                                status.tone === "running" ? "spin" : ""
                              }
                            />
                            {status.label}
                          </em>
                        </span>
                        <span>
                          {run.threadId ? (
                            <button
                              className="button"
                              type="button"
                              onClick={() => onOpenThread?.(run.threadId)}
                            >
                              查看线程 <ExternalLink />
                            </button>
                          ) : (
                            "—"
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {visibleRuns.length === 0 ? (
                  <div className="schedule-empty">
                    <History />
                    <h3>暂无执行记录</h3>
                    <p>每次手动或自动执行，都会在这里留下完整记录。</p>
                  </div>
                ) : null}
              </section>
            )}
          </>
        )}
      </div>

      <div
        className={classNames("modal-backdrop", modalOpen && "open")}
        hidden={!modalOpen}
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-create-title"
      >
        <form
          className="arrangement-modal-card schedule-create-modal"
          onSubmit={(event) => void createSchedule(event)}
        >
          <header className="arrangement-modal-header">
            <div>
              <h2 id="schedule-create-title">新建个人日程</h2>
              <p>CrewON 会按你的安排自动执行，并将结果发送给你。</p>
            </div>
            <button
              className="icon-action compact"
              type="button"
              aria-label="关闭"
              onClick={onCloseModal}
            >
              <X />
            </button>
          </header>
          <label className="form-field">
            <span>日程名称</span>
            <input
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="form-field">
            <span>要完成什么</span>
            <textarea
              required
              rows={4}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <fieldset className="schedule-frequency">
            <legend>执行频率</legend>
            {[
              ["daily", "每天"],
              ["weekly", "每周"],
              ["interval", "按间隔"],
              ["once", "单次"],
            ].map(([value, label]) => (
              <button
                className={frequency === value ? "active" : ""}
                key={value}
                type="button"
                onClick={() => setFrequency(value as Frequency)}
              >
                {label}
              </button>
            ))}
          </fieldset>
          <div className="schedule-time-fields">
            {frequency === "daily" || frequency === "weekly" ? (
              <label className="form-field">
                <span>执行时间</span>
                <input
                  type="time"
                  required
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
              </label>
            ) : null}
            {frequency === "weekly" ? (
              <label className="form-field">
                <span>星期</span>
                <select
                  value={weekday}
                  onChange={(event) => setWeekday(Number(event.target.value))}
                >
                  {["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map(
                    (label, value) => (
                      <option value={value} key={label}>
                        {label}
                      </option>
                    ),
                  )}
                </select>
              </label>
            ) : null}
            {frequency === "interval" ? (
              <label className="form-field">
                <span>间隔（分钟）</span>
                <input
                  type="number"
                  min={5}
                  max={525600}
                  value={intervalMinutes}
                  onChange={(event) =>
                    setIntervalMinutes(Number(event.target.value))
                  }
                />
              </label>
            ) : null}
            {frequency === "once" ? (
              <label className="form-field">
                <span>执行日期与时间</span>
                <input
                  type="datetime-local"
                  required
                  value={runAt}
                  onChange={(event) => setRunAt(event.target.value)}
                />
              </label>
            ) : null}
          </div>
          <section className="schedule-delivery">
            <Inbox />
            <div>
              <strong>结果发送给：我（创建者）</strong>
              <span>
                保存在个人日程中心和专属结果线程，可从执行记录随时查看。
              </span>
            </div>
          </section>
          <footer className="arrangement-modal-actions">
            <button className="button" type="button" onClick={onCloseModal}>
              取消
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={busy === "create"}
            >
              {busy === "create" ? (
                <LoaderCircle className="spin" />
              ) : (
                <CalendarClock />
              )}
              {busy === "create" ? "创建中…" : "创建并启用"}
            </button>
          </footer>
        </form>
      </div>
    </section>
  );
}
