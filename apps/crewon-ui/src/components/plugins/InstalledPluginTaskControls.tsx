import type { Locale } from "../../lib/i18n";
import type { ExtensionTaskView } from "@crewon/contracts";
import type { InstalledPluginTaskContextState } from "../../lib/plugins/useInstalledPluginTaskContext.types";
import { Button } from "../ui/button";
import styles from "./InstalledPluginTaskControls.module.css";

type TaskStatus =
  | ExtensionTaskView["runStatus"]
  | ExtensionTaskView["operations"][number]["status"];
function taskStatus(status: TaskStatus, zh: boolean): string {
  const labels: Record<TaskStatus, string> = zh
    ? {
        queued: "等待执行",
        running: "执行中",
        waitingApproval: "等待批准",
        suspended: "已暂停",
        reconciling: "恢复中",
        completed: "已完成",
        failed: "失败",
        canceled: "已取消",
        submitting: "提交中",
        submitted: "已提交",
        succeeded: "已生成",
        unknownOutcome: "结果待确认",
      }
    : {
        queued: "Queued",
        running: "Running",
        waitingApproval: "Awaiting approval",
        suspended: "Suspended",
        reconciling: "Recovering",
        completed: "Completed",
        failed: "Failed",
        canceled: "Canceled",
        submitting: "Submitting",
        submitted: "Submitted",
        succeeded: "Generated",
        unknownOutcome: "Outcome unconfirmed",
      };
  return labels[status];
}

/** Generic task navigation stays host-owned; the installed module owns its business form. */
export function InstalledPluginTaskControls({
  state,
  locale,
  onOpenTask,
}: Readonly<{
  state: InstalledPluginTaskContextState;
  locale: Locale;
  onOpenTask(threadId: string): void;
}>) {
  const zh = locale === "zh";
  const busy = state.phase === "loading" || state.phase === "preparing";
  const operations = new Map<
    string,
    Readonly<{ sourceRunId: string; operationId: string; label: string }>
  >();
  for (const task of state.tasks)
    for (const operation of task.operations) {
      const key = JSON.stringify([
        operation.sourceRunId,
        operation.operationId,
      ]);
      if (!operations.has(key))
        operations.set(key, {
          sourceRunId: operation.sourceRunId,
          operationId: operation.operationId,
          label: `${operation.images[0]?.filename ?? (zh ? `生成记录 ${operations.size + 1}` : `Record ${operations.size + 1}`)} · ${taskStatus(operation.status, zh)}`,
        });
    }
  const selected = state.source
    ? JSON.stringify([state.source.sourceRunId, state.source.operationId])
    : "";
  return (
    <section
      className={styles.controls}
      aria-label={zh ? "模块任务" : "Module tasks"}
    >
      <div className={styles.actions}>
        {!state.thread ? (
          <Button size="sm" disabled={busy} onClick={state.prepareThread}>
            {state.phase === "uncertain"
              ? zh
                ? "重试创建任务"
                : "Retry creating task"
              : zh
                ? "创建任务"
                : "Create task"}
          </Button>
        ) : (
          <span role="status">
            {zh ? "任务会话已就绪" : "Task conversation ready"}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || state.phase === "uncertain"}
          onClick={state.refresh}
        >
          {zh ? "刷新任务状态" : "Refresh task status"}
        </Button>
      </div>
      {busy ? (
        <p role="status">{zh ? "正在读取任务…" : "Reading task…"}</p>
      ) : null}
      {state.error ? (
        <p role="alert">
          {state.phase === "uncertain"
            ? zh
              ? "创建结果尚未确认，请重试同一次请求。"
              : "Creation is not confirmed. Retry the same request."
            : zh
              ? "任务暂时无法读取，请刷新后重试。"
              : "The task could not be read. Refresh to retry."}
        </p>
      ) : null}
      {operations.size ? (
        <label className={styles.source}>
          <span>{zh ? "查询生成记录" : "Generation record to query"}</span>
          <select
            aria-label={zh ? "查询生成记录" : "Generation record to query"}
            value={selected}
            disabled={busy}
            onChange={(event) => {
              const source = operations.get(event.currentTarget.value);
              state.selectSource(
                source
                  ? {
                      sourceRunId: source.sourceRunId,
                      operationId: source.operationId,
                    }
                  : null,
              );
            }}
          >
            <option value="">{zh ? "选择一条记录" : "Select a record"}</option>
            {[...operations].map(([key, operation]) => (
              <option key={key} value={key}>
                {operation.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {state.tasks.length ? (
        <ul
          className={styles.tasks}
          aria-label={zh ? "已受理任务" : "Accepted tasks"}
        >
          {state.tasks.map((task, index) => (
            <li key={task.runId}>
              <span>
                {zh ? `任务 ${index + 1}` : `Task ${index + 1}`} ·{" "}
                {taskStatus(task.runStatus, zh)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onOpenTask(task.threadId)}
              >
                {zh ? "打开任务" : "Open task"}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
