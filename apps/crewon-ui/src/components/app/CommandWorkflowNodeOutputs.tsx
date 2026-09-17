import type { CrewonWorkflowExecution } from "../../lib/workflow/crewonWorkflow";
import { renderMarkdown } from "../TranscriptMarkdown";
import { useHasTaskWorkbench } from "../workbench/TaskWorkbenchContext";
import { MessageActions } from "../messages/MessageActions";

/** A verification verdict must not hide the work that was actually produced. */
export function CommandWorkflowNodeOutputs({
  execution,
}: {
  execution: CrewonWorkflowExecution;
}) {
  const hasWorkbench = useHasTaskWorkbench();
  const outputs = execution.executedNodes.filter(
    (node) =>
      node.nodeType === "agent" &&
      node.status === "completed" &&
      node.output.trim() &&
      node.output.trim() !== execution.output.trim(),
  );
  if (outputs.length === 0) return null;
  const verdictOnly = /^VERDICT: (PASS|FAIL)$/.test(execution.output.trim());

  return (
    <section className="workflow-node-outputs" aria-label="节点产出">
      <p>节点产出保留在下方，供你核对；执行完成不代表已经对外发送或发布。</p>
      {outputs.map((node, index) => (
        <details
          key={`${execution.executionId}:${node.nodeId}`}
          data-workbench-origin={
            hasWorkbench
              ? `workflow-node:${execution.executionId}:${node.nodeId}`
              : undefined
          }
          tabIndex={hasWorkbench ? -1 : undefined}
          open={verdictOnly && index === outputs.length - 1}
        >
          <summary>{node.title} · 查看产出</summary>
          <div className="workflow-node-output-body">
            {renderMarkdown(node.output)}
            <MessageActions text={node.output} locale="zh" />
          </div>
        </details>
      ))}
    </section>
  );
}
