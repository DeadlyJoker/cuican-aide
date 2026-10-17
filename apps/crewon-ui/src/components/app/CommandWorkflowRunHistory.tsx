import type { CrewonWorkflowRecord } from "../../lib/workflow/crewonWorkflow";
import type { WorkflowReadScope } from "../../lib/control-runtime/controlDurableWorkflowRuntime";
export function CommandWorkflowRunHistory({
  record,
  onInspect,
  onNewRun,
}: {
  record: CrewonWorkflowRecord;
  onInspect?: (scope: WorkflowReadScope) => void | Promise<void>;
  onNewRun?: (workflowVersionId: string) => void;
}) {
  const control = record.control;
  if (!control) return null;
  return (
    <section className="workflow-control-tools" aria-label="协作流运行记录">
      {control.readOnlyReason ? (
        <p role="status">{control.readOnlyReason}</p>
      ) : null}
      {control.source === "durable" && control.loaded ? (
        <>
          {control.roots?.length || control.root ? (
            <label>
              运行记录
              <select
                aria-label="选择协作流运行"
                value={control.knownRunId ?? ""}
                onChange={(event) => {
                  if (!event.target.value) {
                    onNewRun?.(control.workflowVersionId);
                    return;
                  }
                  void onInspect?.({
                    workflowVersionId: control.workflowVersionId,
                    runId: event.target.value,
                  });
                }}
              >
                {control.knownRunId === null ? (
                  <option value="">新运行（当前主会话）</option>
                ) : null}
                {control.root &&
                !control.roots?.some(
                  (run) => run.runId === control.root!.runId,
                ) ? (
                  <option value={control.root.runId}>
                    {control.root.createdAt} · {control.root.runId}
                  </option>
                ) : null}
                {control.roots?.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {run.createdAt} · {run.runId}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {control.nextRootCursor ? (
            <button
              className="button compact"
              type="button"
              onClick={() =>
                void onInspect?.({
                  workflowVersionId: control.workflowVersionId,
                  runId: null,
                  cursor: control.nextRootCursor,
                })
              }
            >
              更早的运行
            </button>
          ) : null}
          <button
            className="button compact"
            type="button"
            onClick={() =>
              void onInspect?.({
                workflowVersionId: control.workflowVersionId,
                runId: null,
              })
            }
          >
            最近的运行
          </button>
          {onNewRun ? (
            <button
              className="button compact"
              type="button"
              disabled={
                control.canStart === false || Boolean(control.readOnlyReason)
              }
              onClick={() => onNewRun(control.workflowVersionId)}
            >
              发起新运行
            </button>
          ) : null}
        </>
      ) : null}
      {control.inputMode === "json" && control.inputSchema ? (
        <details>
          <summary>输入格式（JSON）</summary>
          <pre>{JSON.stringify(control.inputSchema, null, 2)}</pre>
        </details>
      ) : null}
      {control.awaitingSnapshot ? (
        <p role="status">请求已确认，正在同步任务状态。</p>
      ) : null}
    </section>
  );
}
