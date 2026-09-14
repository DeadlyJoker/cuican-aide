import {
  parseSkillInvocationSpec,
  type AutomationSchedule,
  type SkillInvocationSpec,
} from "@crewon/contracts";
import { CalendarClock, LoaderCircle } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "../shared/ModalDialog";
import type { AutomationCreateIntent } from "../../lib/control-runtime/controlAutomationRuntime";
import type { AutomationCreateDraft } from "./automationCreateDraft";
import { AutomationSkillFields } from "./AutomationSkillFields";
import { automationErrorMessage } from "./automationErrorMessage";
import {
  TaskToolPermissionSelect,
  type TaskToolPermissionMode,
} from "../composer/TaskToolPermissionSelect";

export function CommandAutomationCreateDialog({
  busy,
  connected,
  createDraft,
  error,
  onClose,
  onSubmit,
  runtimeAvailable,
  selectedThreadId,
}: {
  busy: boolean;
  connected: boolean;
  createDraft?: AutomationCreateDraft | null;
  error: string | null;
  onClose: () => void;
  onSubmit: (intent: AutomationCreateIntent) => Promise<void>;
  runtimeAvailable: boolean;
  selectedThreadId: string | null;
}) {
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
  const [skillInvocation, setSkillInvocation] = useState<
    SkillInvocationSpec | undefined
  >(() =>
    createDraft?.skillInvocation === undefined
      ? undefined
      : structuredClone(createDraft.skillInvocation),
  );
  const [parameterBindings, setParameterBindings] = useState<
    AutomationCreateIntent["parameterBindings"]
  >(() =>
    createDraft?.parameterBindings === undefined
      ? undefined
      : structuredClone(createDraft.parameterBindings),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [toolPermissionMode, setToolPermissionMode] =
    useState<TaskToolPermissionMode>("requestApproval");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const targetMismatch =
    skillInvocation?.deliveryTarget !== undefined &&
    skillInvocation.deliveryTarget.threadId !== selectedThreadId;
  const displayedError = targetMismatch
    ? "交付目标与当前对话不一致。请返回 Skill 选择当前对话的交付目标，再添加到日程。"
    : (validationError ?? error);

  async function createAutomation(event: FormEvent) {
    event.preventDefault();
    if (
      busy ||
      submittingRef.current ||
      !connected ||
      !runtimeAvailable ||
      selectedThreadId === null ||
      targetMismatch ||
      !title.trim() ||
      !prompt.trim()
    )
      return;
    setValidationError(null);
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const invocation =
        skillInvocation === undefined
          ? undefined
          : parseSkillInvocationSpec(skillInvocation);
      const schedule = createSchedule({
        frequency,
        time,
        weekday,
        intervalMinutes,
        runAt,
      });
      await onSubmit({
        threadId: selectedThreadId,
        title: title.trim(),
        prompt: prompt.trim(),
        agentVersionId: null,
        schedule,
        ...(invocation === undefined
          ? {}
          : { skillInvocation: invocation, toolPermissionMode }),
        ...(parameterBindings === undefined ||
        Object.keys(parameterBindings).length === 0
          ? {}
          : { parameterBindings }),
      });
    } catch (error) {
      setValidationError(
        automationErrorMessage(error, "请检查日程参数后重试。"),
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <ModalDialog
      busy={busy}
      closeLabel="关闭"
      description={
        skillInvocation
          ? "已绑定 Skill 的固定版本。确认参数和时间后，执行结果会回到绑定的对话。"
          : createDraft
            ? "已从助理带入当前请求。确认时间后，到点会自动执行并把结果发回这个对话。"
            : "设定时间和要做的事，到点自动执行，结果保存在绑定的对话里。"
      }
      onClose={onClose}
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
        {skillInvocation ? (
          <AutomationSkillFields
            invocation={skillInvocation}
            parameterBindings={parameterBindings}
            onChange={setSkillInvocation}
            onBindingsChange={setParameterBindings}
          />
        ) : (
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
        )}
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
                  onChange={(event) => setWeekday(Number(event.target.value))}
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
        {skillInvocation ? (
          <>
            <p className="text-sm text-muted-foreground">
              日程时区：
              {Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
            </p>
            <TaskToolPermissionSelect
              scope="schedule"
              value={toolPermissionMode}
              onChange={setToolPermissionMode}
              disabled={busy || submitting}
            />
          </>
        ) : null}
        <section className="schedule-delivery">
          <CalendarClock />
          <div>
            <strong>
              {skillInvocation?.deliveryTarget
                ? "交付到绑定对话的成果集合"
                : "绑定当前对话"}
            </strong>
            <span>
              {selectedThreadId !== null
                ? "执行结果会发送到这个对话，可以随时打开回看。"
                : "请先选择一个对话，日程的执行结果会保存在那里。"}
            </span>
          </div>
        </section>
        {displayedError ? (
          <p className="schedule-alert" role="alert">
            {displayedError}
          </p>
        ) : null}
        <footer className="arrangement-modal-actions">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="submit"
            disabled={
              busy ||
              !connected ||
              !runtimeAvailable ||
              selectedThreadId === null ||
              targetMismatch
            }
          >
            {busy ? <LoaderCircle className="spin" /> : <CalendarClock />}
            {busy ? "创建中…" : "创建并启用"}
          </Button>
        </footer>
      </form>
    </ModalDialog>
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
