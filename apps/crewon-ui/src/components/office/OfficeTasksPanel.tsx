import type { OfficeTask, OfficeWorkspace } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

function officeTaskStatusLabel(status: OfficeTask["status"], locale: Locale) {
  if (locale === "zh") {
    return status === "done"
      ? "完成"
      : status === "doing"
        ? "进行中"
        : "待办";
  }
  return status === "done"
    ? "Done"
    : status === "doing"
      ? "In progress"
      : "To do";
}

export function OfficeTasksPanel({
  workspace,
  locale,
}: {
  workspace: OfficeWorkspace;
  locale: Locale;
}) {
  return (
    <aside
      className="office-tasks"
      aria-label={locale === "zh" ? "任务" : "Tasks"}
    >
      <div className="office-rail-head">
        <strong>{locale === "zh" ? "任务看板" : "Task board"}</strong>
        <span>{workspace.tasks.length}</span>
      </div>
      {workspace.tasks.map((task, index) => (
        <div
          className="office-task"
          data-status={task.status}
          key={`${task.title}:${index}`}
        >
          <span className="office-task-dot" aria-hidden="true" />
          <span className="office-task-text">
            <strong>{task.title}</strong>
            <span>{task.owner}</span>
          </span>
          <span className="office-task-status" data-status={task.status}>
            {officeTaskStatusLabel(task.status, locale)}
          </span>
        </div>
      ))}
    </aside>
  );
}
