import type {
  MessageView,
  RunView,
  ThreadView,
  WorkflowVersionView,
} from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

import type {
  CrewonWorkflowExecution,
  CrewonWorkflowNodeExecution,
  CrewonWorkflowRecord,
} from "../workflow/crewonWorkflow";

const DEFINITION_PREFIX = "__crewon_workflow_definition__:";
const EXECUTION_PREFIX = "__crewon_workflow_run__:";
const INPUT_MARKER = "[Control Workflow · input]";
const CANCEL_MARKER = "[Control Workflow · canceled]";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_RUN_DEADLINE_MS = 15 * 60 * 1_000;

const promptSchema = {
  type: "object" as const,
  properties: {
    prompt: { type: "string" as const, maxLength: 9_999, enum: null },
  },
  required: ["prompt"],
  additionalProperties: false as const,
};
const resultSchema = {
  type: "object" as const,
  properties: {
    result: { type: "string" as const, maxLength: 9_999, enum: null },
  },
  required: ["result"],
  additionalProperties: false as const,
};

export type ControlWorkflowRuntimeClient = Pick<
  ControlApiClient,
  | "appendThreadMessage"
  | "cancelRun"
  | "createRun"
  | "createThread"
  | "forkThread"
  | "getRun"
  | "getThread"
  | "getWorkflowVersion"
  | "listThreadMessages"
  | "listThreadRuns"
  | "listThreads"
  | "publishWorkflowVersion"
  | "renameThread"
>;

export type ControlWorkflowCreateInput = Readonly<{
  title: string;
  description: string;
  nodes: readonly (
    | Readonly<{
        type: "agent" | "verification";
        title: string;
        instruction: string;
        agentVersionId: string;
      }>
    | Readonly<{
        type: "humanGate";
        title: string;
        instruction: string;
      }>
  )[];
}>;

/**
 * Runs immutable Control Workflow definitions with production Turn authority.
 *
 * The experimental server-side DAG admission port is intentionally not used:
 * no current Store implements its atomic composition contract. Each execution
 * instead owns a durable hidden Thread. Agent nodes create normal pinned Runs,
 * while gate decisions and prior outputs remain reconstructable messages. A
 * renderer restart can therefore reload or continue the same execution.
 */
export class ControlWorkflowRuntime {
  readonly #client: ControlWorkflowRuntimeClient;
  readonly #pollIntervalMs: number;
  readonly #runDeadlineMs: number;
  readonly #resumingExecutionIds = new Set<string>();

  constructor(config: {
    client: ControlWorkflowRuntimeClient;
    pollIntervalMs?: number;
    runDeadlineMs?: number;
  }) {
    this.#client = config.client;
    this.#pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#runDeadlineMs = config.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS;
  }

  async createWorkflow(
    input: ControlWorkflowCreateInput,
  ): Promise<CrewonWorkflowRecord> {
    validateCreateInput(input);
    const workflowId = `workflow-${crypto.randomUUID()}`;
    const workflowVersionId = `workflow-version-${crypto.randomUUID()}`;
    let upstreamSchema: typeof promptSchema | typeof resultSchema =
      promptSchema;
    const nodes = input.nodes.map((node, index) => {
      const nodeId = `node-${String(index + 1).padStart(2, "0")}`;
      const dependsOn =
        index === 0 ? [] : [`node-${String(index).padStart(2, "0")}`];
      if (node.type === "humanGate") {
        return {
          nodeId,
          kind: "humanGate" as const,
          title: node.title,
          instruction: node.instruction,
          dependsOn,
          inputSchema: upstreamSchema,
          outputSchema: upstreamSchema,
          approvalPolicyId: "control-workflow-user-gate-v1",
        };
      }
      const definition =
        node.type === "verification"
          ? {
              nodeId,
              kind: "verification" as const,
              title: node.title,
              instruction: node.instruction,
              dependsOn,
              inputSchema: upstreamSchema,
              outputSchema: resultSchema,
              verifierAgentVersionId: node.agentVersionId,
            }
          : {
              nodeId,
              kind: "agent" as const,
              title: node.title,
              instruction: node.instruction,
              dependsOn,
              inputSchema: upstreamSchema,
              outputSchema: resultSchema,
              agentVersionId: node.agentVersionId,
            };
      upstreamSchema = resultSchema;
      return definition;
    });
    const published = await this.#client.publishWorkflowVersion({
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId,
      workflowVersionId,
      name: input.title.trim(),
      description: input.description.trim(),
      inputSchema: promptSchema,
      outputSchema: upstreamSchema,
      entryNodeIds: [nodes[0]!.nodeId],
      outputNodeIds: [nodes.at(-1)!.nodeId],
      nodes,
    });
    if (
      published.workflowVersion.workflowVersionId !== workflowVersionId ||
      published.workflowVersion.workflowId !== workflowId
    ) {
      throw new Error("control_workflow_publish_response_invalid");
    }
    await this.#client.createThread(
      { title: definitionTitle(workflowVersionId) },
      `workflow.definition.${workflowVersionId}`,
    );
    return workflowRecord(published.workflowVersion, []);
  }

  async listWorkflows(): Promise<readonly CrewonWorkflowRecord[]> {
    const threads = await this.#listThreads();
    const versionIds = new Set<string>();
    for (const thread of threads) {
      const definitionId = parseDefinitionTitle(thread.title);
      const execution = parseExecutionTitle(thread.title);
      if (definitionId !== null) versionIds.add(definitionId);
      if (execution !== null) versionIds.add(execution.workflowVersionId);
    }
    const versions = await Promise.all(
      [...versionIds].map(async (workflowVersionId) => {
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
    return records.sort(
      (left, right) => right.config.updatedAt - left.config.updatedAt,
    );
  }

  async runWorkflow(input: {
    workflowVersionId: string;
    threadId: string;
    prompt: string;
  }): Promise<CrewonWorkflowExecution> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("control_workflow_prompt_invalid");
    const version = (
      await this.#client.getWorkflowVersion(input.workflowVersionId)
    ).workflowVersion;
    const source = (await this.#client.getThread(input.threadId)).thread;
    requireActiveThread(source, input.threadId);
    const executionId = crypto.randomUUID();
    const forked = await this.#client.forkThread(
      input.threadId,
      {
        expectedRevision: source.revision,
        throughHistorySequence: null,
      },
      `workflow.run.fork.${executionId}`,
    );
    const renamed = await this.#client.renameThread(
      forked.thread.threadId,
      {
        expectedRevision: forked.thread.revision,
        title: executionTitle(version.workflowVersionId, executionId),
      },
      `workflow.run.rename.${executionId}`,
    );
    await this.#append(
      renamed.thread.threadId,
      `${INPUT_MARKER}\n${prompt}`,
      `workflow.run.input.${executionId}`,
    );
    return this.#continueExecution({
      executionId,
      threadId: renamed.thread.threadId,
      version,
    });
  }

  async resolveGate(input: {
    workflowVersionId: string;
    executionId: string;
    nodeId: string;
    decision: "approve" | "reject";
    comment: string | null;
  }): Promise<CrewonWorkflowExecution> {
    const located = await this.#locateExecution(
      input.workflowVersionId,
      input.executionId,
    );
    const messages = await this.#messages(located.thread.threadId);
    const node = located.version.nodes.find(
      (candidate) => candidate.nodeId === input.nodeId,
    );
    if (
      node?.kind !== "humanGate" ||
      gateDecision(messages, node.nodeId) !== null
    ) {
      throw new Error("control_workflow_gate_not_pending");
    }
    await this.#append(
      located.thread.threadId,
      [
        gateDecisionMarker(node.nodeId, input.decision),
        input.comment?.trim() || "无补充说明",
      ].join("\n"),
      `workflow.gate.${input.executionId}.${node.nodeId}.${input.decision}`,
    );
    if (input.decision === "reject") {
      return this.#projectExecution(
        located.version,
        located.thread,
        input.executionId,
      );
    }
    return this.#continueExecution({
      executionId: input.executionId,
      threadId: located.thread.threadId,
      version: located.version,
    });
  }

  async cancelWorkflow(input: {
    workflowVersionId: string;
    executionId: string;
  }): Promise<CrewonWorkflowExecution> {
    const located = await this.#locateExecution(
      input.workflowVersionId,
      input.executionId,
    );
    const runs = await this.#runs(located.thread.threadId);
    const active = runs.find((run) => !isTerminalRun(run));
    if (active !== undefined) {
      const canceled = await this.#client.cancelRun(
        active.runId,
        { expectedRevision: active.revision },
        `workflow.run.cancel.${input.executionId}.${active.runId}`,
      );
      await this.#waitForTerminal(canceled.run);
    }
    await this.#append(
      located.thread.threadId,
      CANCEL_MARKER,
      `workflow.run.canceled.${input.executionId}`,
    );
    return this.#projectExecution(
      located.version,
      located.thread,
      input.executionId,
    );
  }

  async #continueExecution(input: {
    executionId: string;
    threadId: string;
    version: WorkflowVersionView;
  }): Promise<CrewonWorkflowExecution> {
    for (const nodeId of input.version.executionOrder) {
      const node = input.version.nodes.find(
        (candidate) => candidate.nodeId === nodeId,
      );
      if (node === undefined) {
        throw new Error("control_workflow_node_missing");
      }
      let messages = await this.#messages(input.threadId);
      if (hasMarker(messages, CANCEL_MARKER)) break;
      if (node.kind === "humanGate") {
        const decision = gateDecision(messages, node.nodeId);
        if (decision === "reject") break;
        if (decision === "approve") continue;
        if (!hasMarker(messages, gateRequestMarker(node.nodeId))) {
          await this.#append(
            input.threadId,
            [gateRequestMarker(node.nodeId), node.title, node.instruction].join(
              "\n",
            ),
            `workflow.gate.request.${input.executionId}.${node.nodeId}`,
          );
        }
        break;
      }
      if (assistantOutputForNode(messages, node.nodeId) !== null) continue;
      const marker = nodePromptMarker(node.nodeId);
      if (!hasMarker(messages, marker)) {
        const rootInput = workflowInput(messages);
        const nodeIndex = input.version.executionOrder.indexOf(node.nodeId);
        const priorOutput =
          input.version.executionOrder
            .slice(0, nodeIndex)
            .reverse()
            .map((priorNodeId) => assistantOutputForNode(messages, priorNodeId))
            .find((output) => output !== null) ?? rootInput;
        await this.#append(
          input.threadId,
          agentNodePrompt(input.version, node, rootInput, priorOutput),
          `workflow.node.prompt.${input.executionId}.${node.nodeId}`,
        );
        messages = await this.#messages(input.threadId);
      }
      let runs = await this.#runs(input.threadId);
      let current = runs.find((run) => !isTerminalRun(run));
      if (current === undefined) {
        const latest = runs[0];
        if (
          latest !== undefined &&
          latest.status !== "completed" &&
          assistantOutputForNode(messages, node.nodeId) === null
        ) {
          break;
        }
        const started = await this.#client.createRun(
          {
            threadId: input.threadId,
            agentVersionId: requireAgentVersionId(node),
          },
          `workflow.node.run.${input.executionId}.${node.nodeId}`,
        );
        current = started.run;
      }
      const terminal = await this.#waitForTerminal(current);
      if (terminal.status !== "completed") break;
    }
    const thread = (await this.#client.getThread(input.threadId)).thread;
    return this.#projectExecution(input.version, thread, input.executionId);
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
        if (execution.status === "running") {
          this.#resumeExecution(version, thread, marker.executionId);
        }
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

  #resumeExecution(
    version: WorkflowVersionView,
    thread: ThreadView,
    executionId: string,
  ): void {
    if (this.#resumingExecutionIds.has(executionId)) return;
    this.#resumingExecutionIds.add(executionId);
    void this.#continueExecution({
      executionId,
      threadId: thread.threadId,
      version,
    })
      .catch(() => undefined)
      .finally(() => this.#resumingExecutionIds.delete(executionId));
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
    const failed = runs.find((run) => run.status === "failed");
    const executedNodes = projectNodes(version, messages, active, failed);
    const rejected = executedNodes.some((node) => node.status === "rejected");
    const waiting = executedNodes.some(
      (node) => node.status === "waitingForApproval",
    );
    const allCompleted =
      executedNodes.length === version.nodes.length &&
      executedNodes.every((node) => node.status === "completed");
    const status = canceled
      ? "canceled"
      : rejected || failed !== undefined
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
          ? (failed?.failure?.code ?? "workflow_gate_rejected")
          : null,
    };
  }

  async #locateExecution(
    workflowVersionId: string,
    executionId: string,
  ): Promise<{ version: WorkflowVersionView; thread: ThreadView }> {
    const [version, threads] = await Promise.all([
      this.#client.getWorkflowVersion(workflowVersionId),
      this.#listThreads(),
    ]);
    const thread = threads.find((candidate) => {
      const marker = parseExecutionTitle(candidate.title);
      return (
        marker?.workflowVersionId === workflowVersionId &&
        marker.executionId === executionId
      );
    });
    if (thread === undefined) {
      throw new Error("control_workflow_execution_not_found");
    }
    return { version: version.workflowVersion, thread };
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

  async #append(threadId: string, content: string, key: string) {
    const current = (await this.#client.getThread(threadId)).thread;
    requireActiveThread(current, threadId);
    return this.#client.appendThreadMessage(
      threadId,
      { expectedRevision: current.revision, content },
      key,
    );
  }

  async #waitForTerminal(run: RunView): Promise<RunView> {
    const deadline = Date.now() + this.#runDeadlineMs;
    let current = run;
    while (!isTerminalRun(current)) {
      if (Date.now() >= deadline) {
        throw new Error("control_workflow_run_deadline_exceeded");
      }
      await new Promise((resolve) => setTimeout(resolve, this.#pollIntervalMs));
      current = (await this.#client.getRun(current.runId)).run;
    }
    return current;
  }
}

export function isInternalControlWorkflowThread(thread: {
  name?: string | null;
  preview?: string | null;
  title?: string | null;
}): boolean {
  const title = thread.title ?? thread.name ?? thread.preview ?? null;
  return (
    parseDefinitionTitle(title) !== null || parseExecutionTitle(title) !== null
  );
}

function workflowRecord(
  version: WorkflowVersionView,
  runs: CrewonWorkflowRecord["config"]["runs"],
): CrewonWorkflowRecord {
  return {
    filePath: `control:workflow-version:${version.workflowVersionId}`,
    savedAt: version.createdAt,
    config: {
      workflowId: version.workflowVersionId,
      name: version.name,
      description: version.description,
      lead:
        version.nodes.find((node) => node.kind === "agent")?.agentVersionId ??
        "Human Gate",
      status: runs?.[0]?.status ?? "ready",
      resourceSource: "crewon",
      createdAt: Date.parse(version.createdAt),
      updatedAt: runs?.[0]?.updatedAt ?? Date.parse(version.createdAt),
      nodes: version.executionOrder.map((nodeId) => {
        const node = version.nodes.find(
          (candidate) => candidate.nodeId === nodeId,
        )!;
        return node.kind === "humanGate"
          ? {
              nodeId: node.nodeId,
              type: "humanGate" as const,
              title: node.title,
              instruction: node.instruction,
            }
          : {
              nodeId: node.nodeId,
              type:
                node.kind === "verification"
                  ? ("verification" as const)
                  : ("agent" as const),
              title: node.title,
              instruction: node.instruction,
              agentId: requireAgentVersionId(node),
              agentName: requireAgentVersionId(node),
            };
      }),
      runs,
    },
  };
}

function projectNodes(
  version: WorkflowVersionView,
  messages: readonly MessageView[],
  active: RunView | undefined,
  failed: RunView | undefined,
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
        status = "completed";
      } else if (prompted && failed !== undefined) {
        status = "failed";
      } else if (prompted && active !== undefined) {
        status = active.status === "queued" ? "queued" : "running";
      }
    }
    if (["failed", "rejected", "waitingForApproval"].includes(status)) {
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
        status === "failed" ? (failed?.failure?.code ?? "run_failed") : null,
    };
  });
}

function agentNodePrompt(
  version: WorkflowVersionView,
  node: WorkflowVersionView["nodes"][number],
  rootInput: string,
  priorOutput: string,
): string {
  return [
    nodePromptMarker(node.nodeId),
    `协作流：${version.name}`,
    `当前节点：${node.title}`,
    `节点任务：${node.instruction}`,
    "",
    "原始输入：",
    rootInput.slice(0, 8_000),
    "",
    "上一阶段输出（首节点与原始输入相同）：",
    priorOutput.slice(0, 8_000),
    "",
    "请只完成当前节点职责，给出可直接交给下一节点的结果；不要跳过 Human Gate。",
  ].join("\n");
}

function validateCreateInput(input: ControlWorkflowCreateInput): void {
  if (
    !input.title.trim() ||
    !input.description.trim() ||
    input.nodes.length === 0 ||
    input.nodes.length > 32 ||
    input.nodes.some(
      (node) =>
        !node.title.trim() ||
        !node.instruction.trim() ||
        (node.type !== "humanGate" && !node.agentVersionId.trim()),
    )
  ) {
    throw new Error("control_workflow_definition_invalid");
  }
  const output = input.nodes.at(-1);
  if (
    output?.type !== "verification" ||
    input.nodes.some(
      (node, index) =>
        index < input.nodes.length - 1 &&
        node.type === "agent" &&
        node.agentVersionId === output.agentVersionId,
    )
  ) {
    throw new Error("control_workflow_independent_verification_required");
  }
}

function definitionTitle(workflowVersionId: string): string {
  return `${DEFINITION_PREFIX}${encodeURIComponent(workflowVersionId)}`;
}

function executionTitle(
  workflowVersionId: string,
  executionId: string,
): string {
  return `${EXECUTION_PREFIX}${encodeURIComponent(workflowVersionId)}:${executionId}`;
}

function parseDefinitionTitle(title: string | null): string | null {
  if (!title?.startsWith(DEFINITION_PREFIX)) return null;
  try {
    return decodeURIComponent(title.slice(DEFINITION_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

type ExecutionMarker = Readonly<{
  workflowVersionId: string;
  executionId: string;
}>;

function parseExecutionTitle(title: string | null): ExecutionMarker | null {
  if (!title?.startsWith(EXECUTION_PREFIX)) return null;
  const value = title.slice(EXECUTION_PREFIX.length);
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  try {
    return {
      workflowVersionId: decodeURIComponent(value.slice(0, separator)),
      executionId: value.slice(separator + 1),
    };
  } catch {
    return null;
  }
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

function requireActiveThread(thread: ThreadView, threadId: string): void {
  if (thread.threadId !== threadId || thread.status !== "active") {
    throw new Error("control_workflow_thread_invalid");
  }
}

function isTerminalRun(run: RunView): boolean {
  return ["canceled", "completed", "failed"].includes(run.status);
}
