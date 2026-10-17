import { useEffect, useRef, useState } from "react";
import type {
  CrewonWorkflowExecution,
  CrewonWorkflowRecord,
} from "../../lib/workflow/crewonWorkflow";
import { renderMarkdown } from "../TranscriptMarkdown";

export type WorkflowEvidenceRequest = Readonly<{
  workflow: CrewonWorkflowRecord;
  executionId: string;
  nodeId: string;
  signal: AbortSignal;
}>;

export function CommandWorkflowVerificationEvidence({
  execution,
  read,
}: {
  execution: CrewonWorkflowExecution;
  read: (input: { nodeId: string; signal: AbortSignal }) => Promise<string>;
}) {
  const [details, setDetails] = useState<
    Record<string, { text?: string; error?: string; busy?: boolean }>
  >({});
  const current = useRef(execution.executionId);
  const live = useRef(false);
  const requests = useRef(new Map<string, AbortController>());
  current.current = execution.executionId;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      for (const request of requests.current.values()) request.abort();
      requests.current.clear();
    };
  }, []);
  const failed = execution.executedNodes.filter(
    (node) =>
      node.nodeType === "verification" &&
      node.status === "failed" &&
      node.threadId,
  );
  if (!failed.length) return null;
  return (
    <section className="workflow-node-outputs" aria-label="验证详情">
      {failed.map((node) => (
        <details
          key={node.nodeId}
          onToggle={(event) => {
            if (!event.currentTarget.open)
              requests.current.get(node.nodeId)?.abort();
          }}
        >
          <summary>{node.title} · 验证未通过</summary>
          <div className="workflow-node-output-body">
            {details[node.nodeId]?.text
              ? renderMarkdown(details[node.nodeId]!.text!)
              : null}
            {details[node.nodeId]?.error ? (
              <p role="alert">暂时无法读取验证详情，可以重试。</p>
            ) : null}
            {!details[node.nodeId]?.text ? (
              <button
                className="button compact"
                type="button"
                disabled={details[node.nodeId]?.busy}
                onClick={async () => {
                  const id = execution.executionId,
                    controller = new AbortController();
                  requests.current.get(node.nodeId)?.abort();
                  requests.current.set(node.nodeId, controller);
                  const owns = () =>
                    live.current &&
                    current.current === id &&
                    requests.current.get(node.nodeId) === controller;
                  setDetails((previous) => ({
                    ...previous,
                    [node.nodeId]: { busy: true },
                  }));
                  try {
                    const text = await read({
                      nodeId: node.nodeId,
                      signal: controller.signal,
                    });
                    if (owns() && !controller.signal.aborted)
                      setDetails((previous) => ({
                        ...previous,
                        [node.nodeId]: { text },
                      }));
                  } catch {
                    if (owns())
                      setDetails((previous) => ({
                        ...previous,
                        [node.nodeId]: {
                          error: controller.signal.aborted
                            ? undefined
                            : "unavailable",
                        },
                      }));
                  } finally {
                    if (requests.current.get(node.nodeId) === controller)
                      requests.current.delete(node.nodeId);
                  }
                }}
              >
                {details[node.nodeId]?.busy ? "正在读取…" : "查看验证详情"}
              </button>
            ) : null}
          </div>
        </details>
      ))}
    </section>
  );
}
