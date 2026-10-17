import type { ControlApiClient } from "@crewon/control-client";
import type {
  MessageView,
  RunView,
  ThreadView,
  WorkflowVersionView,
} from "@crewon/contracts";
import type {
  CrewonWorkflowRecord,
  CrewonWorkflowExecution,
  CrewonWorkflowNodeExecution,
} from "../workflow/crewonWorkflow.ts";
import { workflowVerificationTextError } from "@crewon/domain/workflow-verification";
import { workflowRecord } from "./controlWorkflowVersionProjection.ts";
import {
  parseDefinitionTitle,
  parseExecutionTitle,
  type ExecutionMarker,
} from "./controlWorkflowLegacyMarkers.ts";
const INPUT_MARKER = "[Control Workflow · input]";
const CANCEL_MARKER = "[Control Workflow · canceled]";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
export type ControlWorkflowLegacyClient = Pick<
  ControlApiClient,
  "getWorkflowVersion" | "listThreads" | "listThreadMessages" | "listThreadRuns"
>;
/** Explicit historical discovery only. Reads can never start or resume a Run. */
export class ControlWorkflowLegacyReader {
  readonly #client: ControlWorkflowLegacyClient;
  constructor(client: ControlWorkflowLegacyClient) {
    this.#client = client;
  }
  async listWorkflows(input: { offset: number } = { offset: 0 }) {
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.offset > 10000 ||
      input.offset % 20 !== 0
    )
      throw Error("workflow_legacy_page_invalid");
    const threads = await this.#listThreads();
    const versionIds = new Set<string>();
    for (const thread of threads) {
      const definitionId = parseDefinitionTitle(thread.title);
      const execution = parseExecutionTitle(thread.title);
      if (definitionId !== null) versionIds.add(definitionId);
      if (execution !== null) versionIds.add(execution.workflowVersionId);
    }
    const versions = await Promise.all(
      [...versionIds]
        .sort()
        .slice(input.offset, input.offset + 20)
        .map(async (workflowVersionId) => {
          try {
            return (await this.#client.getWorkflowVersion(workflowVersionId))
              .workflowVersion;
          } catch {
            return null;
          }
        }),
    );
    const executions = threads.flatMap((thread) => {
      const marker = parseExecutionTitle(thread.title);
      return marker === null ? [] : [{ thread, marker }];
    });
    const records = await Promise.all(
      versions.flatMap((version) =>
        version === null
          ? []
          : [this.#recordWithExecutions(version, executions)],
      ),
    );
    return {
      nextOffset:
        versionIds.size > input.offset + 20 ? input.offset + 20 : null,
      records: records.sort(
        (left, right) => right.config.updatedAt - left.config.updatedAt,
      ),
    };
  }

  async #recordWithExecutions(
    version: WorkflowVersionView,
    executions: readonly {
      thread: ThreadView;
      marker: ExecutionMarker;
    }[],
  ): Promise<CrewonWorkflowRecord> {
    const matching = executions
      .filter(
        (execution) =>
          execution.marker.workflowVersionId === version.workflowVersionId,
      )
      .sort((left, right) =>
        right.thread.updatedAt.localeCompare(left.thread.updatedAt),
      );
    const runs = await Promise.all(
      matching.slice(0, 20).map(async ({ thread, marker }) => {
        const execution = await this.#projectExecution(
          version,
          thread,
          marker.executionId,
        );
        const messages = await this.#messages(thread.threadId);
        return {
          executionId: execution.executionId,
          status: execution.status,
          input: workflowInput(messages),
          output: execution.output,
          error: execution.error,
          createdAt: Date.parse(thread.createdAt),
          updatedAt: Date.parse(thread.updatedAt),
          executedNodes: execution.executedNodes,
        };
      }),
    );
    return workflowRecord(version, runs);
  }

  async #projectExecution(
    version: WorkflowVersionView,
    thread: ThreadView,
    executionId: string,
  ): Promise<CrewonWorkflowExecution> {
    const [messages, runs] = await Promise.all([
      this.#messages(thread.threadId),
      this.#runs(thread.threadId),
    ]);
    const canceled = hasMarker(messages, CANCEL_MARKER);
    const active = runs.find((run) => !isTerminalRun(run));
    const failedRun = runs.find((run) => run.status === "failed");
    const executedNodes = projectNodes(
      version,
      messages,
      active,
      failedRun,
      canceled,
    );
    const rejected = executedNodes.some((node) => node.status === "rejected");
    const failedNode = executedNodes.find((node) => node.status === "failed");
    const waiting = executedNodes.some(
      (node) => node.status === "waitingForApproval",
    );
    const allCompleted =
      executedNodes.length === version.nodes.length &&
      executedNodes.every((node) => node.status === "completed");
    const status = canceled
      ? "canceled"
      : rejected || failedRun !== undefined || failedNode !== undefined
        ? "failed"
        : waiting
          ? "waitingForApproval"
          : allCompleted
            ? "completed"
            : active !== undefined
              ? active.status === "queued"
                ? "queued"
                : "running"
              : "running";
    return {
      executionId,
      workflowId: version.workflowVersionId,
      status,
      output: latestWorkflowAssistantContent(version, messages) ?? "",
      executedNodes,
      error:
        status === "failed"
          ? (failedRun?.failure?.code ??
            failedNode?.error ??
            "workflow_gate_rejected")
          : null,
    };
  }

  async #listThreads(): Promise<ThreadView[]> {
    const data: ThreadView[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.#client.listThreads({
        cursor,
        limit: PAGE_SIZE,
      });
      data.push(...response.data);
      if (response.nextCursor === null) return data;
      cursor = response.nextCursor;
    }
    throw new Error("control_workflow_thread_page_limit_exceeded");
  }

  async #messages(threadId: string): Promise<MessageView[]> {
    const data: MessageView[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.#client.listThreadMessages(threadId, {
        cursor,
        limit: PAGE_SIZE,
      });
      data.push(...response.data);
      if (response.nextCursor === null) {
        return data.sort((left, right) => left.sequence - right.sequence);
      }
      cursor = response.nextCursor;
    }
    throw new Error("control_workflow_message_page_limit_exceeded");
  }

  async #runs(threadId: string): Promise<RunView[]> {
    const response = await this.#client.listThreadRuns(threadId, {
      limit: PAGE_SIZE,
    });
    return [...response.data].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }
}
function projectNodes(
  version: WorkflowVersionView,
  messages: readonly MessageView[],
  active: RunView | undefined,
  failedRun: RunView | undefined,
  canceled: boolean,
): CrewonWorkflowNodeExecution[] {
  let terminalSeen = false;
  return version.executionOrder.map((nodeId) => {
    const node = version.nodes.find(
      (candidate) => candidate.nodeId === nodeId,
    )!;
    const output =
      node.kind === "humanGate"
        ? gateDecision(messages, node.nodeId)
        : assistantOutputForNode(messages, node.nodeId);
    const prompted = hasMarker(
      messages,
      node.kind === "humanGate"
        ? gateRequestMarker(node.nodeId)
        : nodePromptMarker(node.nodeId),
    );
    let status = "pending";
    if (!terminalSeen) {
      if (node.kind === "humanGate") {
        status =
          output === "approve"
            ? "completed"
            : output === "reject"
              ? "rejected"
              : prompted
                ? "waitingForApproval"
                : "pending";
      } else if (output !== null) {
        status =
          node.kind === "verification" &&
          verificationError(node, output) !== null
            ? "failed"
            : "completed";
      } else if (prompted && failedRun !== undefined) {
        status = "failed";
      } else if (prompted && active !== undefined) {
        status = active.status === "queued" ? "queued" : "running";
      }
    }
    if (
      canceled &&
      !terminalSeen &&
      prompted &&
      ["pending", "queued", "running", "waitingForApproval"].includes(status)
    ) {
      status = "canceled";
    }
    if (
      ["canceled", "failed", "rejected", "waitingForApproval"].includes(status)
    ) {
      terminalSeen = true;
    }
    return {
      nodeId: node.nodeId,
      nodeType:
        node.kind === "humanGate"
          ? "humanGate"
          : node.kind === "verification"
            ? "verification"
            : "agent",
      title: node.title,
      agentId: node.kind === "humanGate" ? null : requireAgentVersionId(node),
      agentName:
        node.kind === "humanGate" ? undefined : requireAgentVersionId(node),
      status,
      output: typeof output === "string" ? output : "",
      error:
        status === "failed"
          ? node.kind === "verification" && typeof output === "string"
            ? (verificationError(node, output) ??
              failedRun?.failure?.code ??
              "run_failed")
            : (failedRun?.failure?.code ?? "run_failed")
          : null,
    };
  });
}

function verificationError(
  node: Pick<WorkflowVersionView["nodes"][number], "instruction">,
  output: string,
): string | null {
  return workflowVerificationTextError(node.instruction, output);
}

function nodePromptMarker(nodeId: string): string {
  return `[Control Workflow · node:${nodeId}]`;
}

function gateRequestMarker(nodeId: string): string {
  return `[Control Workflow · gate:${nodeId}:request]`;
}

function gateDecisionMarker(
  nodeId: string,
  decision: "approve" | "reject",
): string {
  return `[Control Workflow · gate:${nodeId}:${decision}]`;
}

function hasMarker(messages: readonly MessageView[], marker: string): boolean {
  const executionStart = workflowInputMessage(messages)?.sequence ?? -1;
  return messages.some(
    (message) =>
      message.sequence > executionStart &&
      message.role === "user" &&
      (message.content === marker || message.content.startsWith(`${marker}\n`)),
  );
}

function gateDecision(
  messages: readonly MessageView[],
  nodeId: string,
): "approve" | "reject" | null {
  if (hasMarker(messages, gateDecisionMarker(nodeId, "reject"))) {
    return "reject";
  }
  return hasMarker(messages, gateDecisionMarker(nodeId, "approve"))
    ? "approve"
    : null;
}

function assistantOutputForNode(
  messages: readonly MessageView[],
  nodeId: string,
): string | null {
  const executionStart = workflowInputMessage(messages)?.sequence ?? -1;
  const prompt = messages.find(
    (message) =>
      message.sequence > executionStart &&
      message.role === "user" &&
      message.content.startsWith(`${nodePromptMarker(nodeId)}\n`),
  );
  if (prompt === undefined) return null;
  const nextBoundary = messages.find(
    (message) =>
      message.sequence > prompt.sequence &&
      message.role === "user" &&
      (message.content.startsWith("[Control Workflow · node:") ||
        message.content.startsWith("[Control Workflow · gate:")),
  )?.sequence;
  const assistant = messages.find(
    (message) =>
      message.sequence > prompt.sequence &&
      (nextBoundary === undefined || message.sequence < nextBoundary) &&
      message.role === "assistant",
  );
  return assistant?.content.trim() || null;
}

function workflowInput(messages: readonly MessageView[]): string {
  const input = workflowInputMessage(messages);
  return input?.content.slice(INPUT_MARKER.length + 1).trim() ?? "";
}

function workflowInputMessage(
  messages: readonly MessageView[],
): MessageView | undefined {
  return [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "user" &&
        message.content.startsWith(`${INPUT_MARKER}\n`),
    );
}

function latestWorkflowAssistantContent(
  version: WorkflowVersionView,
  messages: readonly MessageView[],
): string | null {
  for (const nodeId of [...version.executionOrder].reverse()) {
    const output = assistantOutputForNode(messages, nodeId);
    if (output !== null) return output;
  }
  return null;
}

function requireAgentVersionId(
  node: WorkflowVersionView["nodes"][number],
): string {
  const agentVersionId =
    node.kind === "verification"
      ? node.verifierAgentVersionId
      : node.agentVersionId;
  if (!agentVersionId) throw new Error("control_workflow_agent_missing");
  return agentVersionId;
}

function isTerminalRun(run: RunView): boolean {
  return ["canceled", "completed", "failed"].includes(run.status);
}
