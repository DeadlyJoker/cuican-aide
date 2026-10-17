import { streamRunEvents } from "@crewon/control-client";
import type {
  ControlApiClient,
  ControlApiRequestOptions,
} from "@crewon/control-client";
import {
  parseRunView,
  parseStartWorkflowRunRequest,
  parseWorkflowRunSnapshotResponse,
  type RunView,
  type WorkflowVersionView,
  type WorkflowRunSnapshotResponse,
  type RunEventView,
} from "@crewon/contracts";
import {
  parseWorkflowObjectSchema,
  validateWorkflowSchemaValue,
} from "@crewon/domain/workflow-schema";
import type {
  CrewonWorkflowExecution,
  CrewonWorkflowRecord,
} from "../workflow/crewonWorkflow.ts";
import {
  ControlWorkflowCommands,
  type ControlWorkflowCommandsClient,
  type WorkflowCommandRequestOptions,
} from "./controlWorkflowCommands.ts";
import type {
  ControlWorkflowIntentJournal,
  WorkflowIntent,
} from "./controlWorkflowIntentJournal.ts";
import {
  controlWorkflowDefinition,
  type ControlWorkflowCreateInput,
} from "./controlWorkflowDefinition.ts";
import { workflowRecord } from "./controlWorkflowVersionProjection.ts";
import {
  ControlWorkflowLegacyReader,
  type ControlWorkflowLegacyClient,
} from "./controlWorkflowLegacyReader.ts";

export type ControlDurableWorkflowClient = ControlWorkflowCommandsClient &
  ControlWorkflowLegacyClient &
  Pick<
    ControlApiClient,
    | "getWorkflowVersion"
    | "publishWorkflowVersion"
    | "listWorkflowVersionCatalog"
    | "listWorkflowRuns"
    | "getWorkflowRunSnapshot"
    | "getThreadTranscriptSnapshot"
    | "openRunEventStream"
  >;
export type WorkflowReadScope = Readonly<{
  workflowVersionId: string;
  runId: string | null;
  cursor?: string | null;
}>;
export type WorkflowObservation = Readonly<{
  workflowVersionId: string;
  runId: string;
  afterSequence: number;
}>;
export type WorkflowRunObserver = (
  input: WorkflowObservation,
  signal: AbortSignal,
) => AsyncIterable<Pick<RunEventView, "type" | "sequence">>;
const terminal = (run: RunView) =>
  ["completed", "failed", "canceled"].includes(run.status);

/** Immutable definitions + bounded read projections. All execution stays in Worker. */
export class ControlDurableWorkflowRuntime {
  readonly #client: ControlDurableWorkflowClient;
  readonly #commands: ControlWorkflowCommands;
  readonly #versions = new Map<string, WorkflowVersionView>();
  #contextId: string | null | undefined;
  #availabilityEpoch = 0;
  constructor(input: {
    client: ControlDurableWorkflowClient;
    journal?: ControlWorkflowIntentJournal;
  }) {
    this.#client = input.client;
    this.#commands = new ControlWorkflowCommands(input);
  }

  async availability(options: ControlApiRequestOptions = {}) {
    const epoch = ++this.#availabilityEpoch;
    const result = await this.#commands.readAvailability(options);
    if (epoch === this.#availabilityEpoch) {
      if (this.#contextId !== undefined && this.#contextId !== result.contextId)
        this.#versions.clear();
      this.#contextId = result.contextId;
    }
    return result;
  }
  events(input: WorkflowObservation, signal: AbortSignal) {
    return streamRunEvents(this.#client, {
      runId: input.runId,
      afterSequence: input.afterSequence,
      view: "transcript",
      signal,
    });
  }
  async definition(id: string, options: ControlApiRequestOptions = {}) {
    return this.#record(await this.#version(id, options));
  }

  async catalog(
    cursor: string | null,
    options: ControlApiRequestOptions = {},
  ): Promise<{ nextCursor: string | null; records: CrewonWorkflowRecord[] }> {
    const page = await this.#client.listWorkflowVersionCatalog(
      { cursor, limit: 20 },
      options,
    );
    options.signal?.throwIfAborted();
    return {
      nextCursor: page.nextCursor,
      records: page.data.map((version) => ({
        filePath: `control:workflow-version:${version.workflowVersionId}`,
        savedAt: version.createdAt,
        config: {
          workflowId: version.workflowVersionId,
          name: version.name,
          description: version.description,
          lead: "",
          status: "ready",
          resourceSource: "crewon" as const,
          createdAt: Date.parse(version.createdAt),
          updatedAt: Date.parse(version.createdAt),
          nodes: [],
          runs: [],
        },
        control: {
          source: "durable" as const,
          workflowVersionId: version.workflowVersionId,
          loaded: false,
          readOnlyReason: "正在读取定义",
          inputMode: "json" as const,
          inputSchema: null,
          knownRunId: null,
        },
      })),
    };
  }

  async read(
    scope: WorkflowReadScope,
    options: ControlApiRequestOptions = {},
  ): Promise<CrewonWorkflowRecord> {
    const version = await this.#version(scope.workflowVersionId, options);
    if (scope.runId !== null)
      return this.#snapshot(version, scope.runId, options);
    const roots = await this.#client.listWorkflowRuns(
      {
        workflowVersionId: version.workflowVersionId,
        cursor: scope.cursor ?? null,
        limit: 20,
      },
      options,
    );
    options.signal?.throwIfAborted();
    const record = roots.data[0]
      ? await this.#snapshot(version, roots.data[0].runId, options)
      : this.#record(version);
    record.control!.roots = roots.data;
    record.control!.nextRootCursor = roots.nextCursor;
    return record;
  }

  async createWorkflow(
    input: ControlWorkflowCreateInput,
    options: ControlApiRequestOptions = {},
  ): Promise<CrewonWorkflowRecord> {
    const source = controlWorkflowDefinition(input);
    const { workflowVersion } = await this.#client.publishWorkflowVersion(
      source,
      options,
    );
    options.signal?.throwIfAborted();
    if (
      workflowVersion.workflowVersionId !== source.workflowVersionId ||
      workflowVersion.workflowId !== source.workflowId
    )
      throw new Error("control_workflow_publish_response_invalid");
    this.#remember(workflowVersion);
    return this.#record(workflowVersion);
  }

  async runWorkflow(
    input: { workflowVersionId: string; threadId: string; prompt: string },
    options: WorkflowCommandRequestOptions = {},
  ): Promise<CrewonWorkflowRecord> {
    const version = await this.#version(input.workflowVersionId, options);
    const schema = parseWorkflowObjectSchema(version.inputSchema);
    const value =
      inputMode(version) === "prompt"
        ? { prompt: input.prompt }
        : JSON.parse(input.prompt);
    const validated = validateWorkflowSchemaValue(value, schema);
    const body = parseStartWorkflowRunRequest({
      workflowVersionId: version.workflowVersionId,
      threadId: input.threadId,
      input: validated,
    });
    const result = await this.#commands.start(body, options);
    if (result.kind !== "start")
      throw new Error("workflow_start_result_invalid");
    return this.#accepted(
      version,
      result.response.run,
      formatWorkflowValue(body.input),
    );
  }

  async cancelWorkflow(
    input: { workflowVersionId: string; executionId: string },
    options: WorkflowCommandRequestOptions = {},
  ): Promise<CrewonWorkflowRecord> {
    const version = await this.#version(input.workflowVersionId, options);
    const snapshot = await this.#readSnapshot(
      version,
      input.executionId,
      options,
    );
    if (terminal(snapshot.run) || snapshot.run.cancelRequested)
      return this.#project(version, snapshot);
    const result = await this.#commands.cancel(snapshot, options);
    if (result.kind !== "cancel")
      throw new Error("workflow_cancel_result_invalid");
    const record = this.#project(version, snapshot);
    const run = result.response.run;
    record.control!.root = run;
    record.config.runs![0]!.status = runStatus(run);
    record.config.status = runStatus(run);
    return record;
  }

  async resolveGate(
    input: {
      workflowVersionId: string;
      executionId: string;
      nodeId: string;
      decision: "approve" | "reject";
      comment: string | null;
    },
    options: WorkflowCommandRequestOptions = {},
  ): Promise<CrewonWorkflowRecord> {
    const version = await this.#version(input.workflowVersionId, options);
    const snapshot = await this.#readSnapshot(
      version,
      input.executionId,
      options,
    );
    await this.#commands.review(
      {
        snapshot,
        nodeId: input.nodeId,
        decision: input.decision === "approve" ? "approved" : "rejected",
        comment: input.comment,
        commentContext: "descendants-v1",
      },
      options,
    );
    const record = this.#project(version, snapshot);
    // The receipt confirms the decision, not the next execution snapshot.
    record.control!.awaitingSnapshot = true;
    return record;
  }

  async recover(
    intent: WorkflowIntent,
    options: WorkflowCommandRequestOptions = {},
  ): Promise<CrewonWorkflowRecord> {
    const result = await this.#commands.recover(intent.id, options);
    const version = await this.#version(
      result.intent.workflowVersionId,
      options,
    );
    if (result.kind !== "review")
      return this.#accepted(
        version,
        result.response.run,
        result.intent.command.kind === "start"
          ? formatWorkflowValue(result.intent.command.body.input)
          : "",
      );
    const record = this.#record(version);
    const runId = result.response.review.decision.authority.runId;
    record.control!.knownRunId = runId;
    record.control!.awaitingSnapshot = true;
    record.config.status = "reconciling";
    record.config.runs = [
      {
        executionId: runId,
        status: "reconciling",
        input: "",
        output: "",
        error: null,
        createdAt: Date.parse(result.intent.createdAt),
        updatedAt: Date.parse(result.intent.createdAt),
        executedNodes: [],
      },
    ];
    return record;
  }

  async legacy(
    offset = 0,
  ): Promise<{ nextCursor: string | null; records: CrewonWorkflowRecord[] }> {
    const page = await new ControlWorkflowLegacyReader(
      this.#client,
    ).listWorkflows({ offset });
    return {
      nextCursor: page.nextOffset === null ? null : `legacy:${page.nextOffset}`,
      records: page.records.map(
        (record) =>
          ({
            ...record,
            config: {
              ...record.config,
              workflowId: `legacy:${record.config.workflowId}`,
            },
            control: {
              source: "legacy",
              workflowVersionId: record.config.workflowId,
              loaded: true,
              readOnlyReason: "旧版执行记录仅供查看，不会自动继续或重新发送",
              inputMode: "prompt",
              inputSchema: null,
              knownRunId: null,
            },
          }) as CrewonWorkflowRecord,
      ),
    };
  }

  /** Evidence is read-only, separate from successful node output. */
  async verificationEvidence(
    input: { workflowVersionId: string; runId: string; nodeId: string },
    options: ControlApiRequestOptions = {},
  ): Promise<string> {
    const version = await this.#version(input.workflowVersionId, options);
    const snapshot = await this.#readSnapshot(version, input.runId, options);
    const node = snapshot.nodes.find((node) => node.nodeId === input.nodeId);
    if (
      node?.kind !== "verification" ||
      node.status !== "failed" ||
      node.child === null
    )
      throw Error("workflow_verification_evidence_unavailable");
    const transcript = await this.#client.getThreadTranscriptSnapshot(
      node.child.threadId,
      { limit: 10 },
      options,
    );
    options.signal?.throwIfAborted();
    const bound = new Set(
      transcript.transcriptWindow.runBindings
        .filter((binding) => binding.runId === node.child!.runId)
        .map((binding) => binding.messageId),
    );
    const replies = transcript.transcriptWindow.messageWindow.data.filter(
      (message) =>
        message.threadId === node.child!.threadId &&
        message.role === "assistant" &&
        bound.has(message.messageId),
    );
    const content = replies.sort((a, b) => b.sequence - a.sequence)[0]?.content;
    if (content === undefined)
      throw Error("workflow_verification_evidence_unavailable");
    try {
      return formatWorkflowValue(JSON.parse(content));
    } catch {
      return content;
    }
  }

  async #version(id: string, options: ControlApiRequestOptions) {
    const cached = this.#versions.get(id);
    if (cached) return cached;
    const contextId = this.#contextId;
    const { workflowVersion } = await this.#client.getWorkflowVersion(
      id,
      options,
    );
    options.signal?.throwIfAborted();
    if (workflowVersion.workflowVersionId !== id)
      throw Error("workflow_version_binding_invalid");
    parseWorkflowObjectSchema(workflowVersion.inputSchema);
    if (contextId === this.#contextId) this.#remember(workflowVersion);
    return workflowVersion;
  }
  #remember(version: WorkflowVersionView) {
    this.#versions.set(version.workflowVersionId, structuredClone(version));
    if (this.#versions.size > 20)
      this.#versions.delete(this.#versions.keys().next().value!);
  }
  #record(version: WorkflowVersionView): CrewonWorkflowRecord {
    const record = workflowRecord(version, []);
    record.control = {
      source: "durable",
      workflowVersionId: version.workflowVersionId,
      loaded: true,
      readOnlyReason: null,
      inputMode: inputMode(version),
      inputSchema: structuredClone(version.inputSchema),
      knownRunId: null,
    };
    return record;
  }
  async #readSnapshot(
    version: WorkflowVersionView,
    runId: string,
    options: ControlApiRequestOptions,
  ) {
    const snapshot = parseWorkflowRunSnapshotResponse(
      await this.#client.getWorkflowRunSnapshot(runId, options),
      runId,
    );
    options.signal?.throwIfAborted();
    if (
      snapshot.run.workflowVersionBinding?.workflowVersionId !==
        version.workflowVersionId ||
      snapshot.run.workflowVersionBinding.contentDigest !==
        version.contentDigest
    )
      throw Error("workflow_snapshot_binding_invalid");
    if (
      snapshot.nodes.length !== version.nodes.length ||
      snapshot.nodes.some((node) => {
        const definition = version.nodes.find(
          (candidate) => candidate.nodeId === node.nodeId,
        );
        const agent =
          definition?.kind === "verification"
            ? definition.verifierAgentVersionId
            : definition?.agentVersionId;
        return (
          !definition ||
          definition.kind !== node.kind ||
          (agent ?? null) !== node.agentVersionId
        );
      })
    )
      throw Error("workflow_snapshot_nodes_invalid");
    validateWorkflowSchemaValue(
      snapshot.input,
      parseWorkflowObjectSchema(version.inputSchema),
    );
    return snapshot;
  }
  async #snapshot(
    version: WorkflowVersionView,
    runId: string,
    options: ControlApiRequestOptions,
  ) {
    return this.#project(
      version,
      await this.#readSnapshot(version, runId, options),
    );
  }
  #project(
    version: WorkflowVersionView,
    snapshot: WorkflowRunSnapshotResponse,
  ): CrewonWorkflowRecord {
    const record = this.#record(version),
      status = runStatus(snapshot.run, snapshot.execution?.status);
    record.control!.root = snapshot.run;
    record.control!.knownRunId = snapshot.run.runId;
    record.control!.awaitingSnapshot = false;
    const executedNodes = snapshot.nodes.map((node) => ({
      nodeId: node.nodeId,
      nodeType: node.kind,
      title: node.title,
      agentId: node.agentVersionId,
      status:
        node.status === "waitingHuman" ? "waitingForApproval" : node.status,
      output: node.output === null ? "" : formatWorkflowValue(node.output),
      error: node.failureCode,
      threadId: node.child?.threadId ?? null,
      turnId: node.child?.runId ?? null,
    }));
    const output = version.outputNodeIds
      .map(
        (id) => executedNodes.find((node) => node.nodeId === id)?.output ?? "",
      )
      .filter(Boolean)
      .join("\n\n");
    record.config.status = status;
    record.config.runs = [
      {
        executionId: snapshot.run.runId,
        status,
        input: formatWorkflowValue(snapshot.input),
        output,
        error:
          status === "failed"
            ? (executedNodes.find((node) => node.error)?.error ??
              snapshot.run.failure?.code ??
              null)
            : null,
        createdAt: Date.parse(snapshot.run.createdAt),
        updatedAt: Date.parse(
          snapshot.execution?.updatedAt ?? snapshot.run.updatedAt,
        ),
        executedNodes,
      },
    ];
    return record;
  }
  #accepted(version: WorkflowVersionView, value: RunView, input: string) {
    const run = parseRunView(value),
      record = this.#record(version);
    if (
      run.purpose !== "workflow" ||
      run.workflowVersionBinding?.workflowVersionId !==
        version.workflowVersionId ||
      run.workflowVersionBinding.contentDigest !== version.contentDigest
    )
      throw Error("workflow_run_binding_invalid");
    record.control!.root = run;
    record.control!.knownRunId = run.runId;
    record.control!.awaitingSnapshot = true;
    record.config.status = runStatus(run);
    record.config.runs = [
      {
        executionId: run.runId,
        status: runStatus(run),
        input,
        output: "",
        error: run.failure?.code ?? null,
        createdAt: Date.parse(run.createdAt),
        updatedAt: Date.parse(run.updatedAt),
        executedNodes: [],
      },
    ];
    return record;
  }
}

function inputMode(version: WorkflowVersionView): "prompt" | "json" {
  const schema = parseWorkflowObjectSchema(version.inputSchema);
  return Object.keys(schema.properties).length === 1 &&
    schema.properties.prompt?.type === "string" &&
    schema.required.length === 1 &&
    schema.required[0] === "prompt"
    ? "prompt"
    : "json";
}
function runStatus(run: RunView, executionStatus?: string): string {
  if (terminal(run)) return run.status;
  if (run.cancelRequested) return "canceling";
  return executionStatus === "waitingHuman" ? "waitingForApproval" : run.status;
}
export function formatWorkflowValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    typeof (value as { result?: unknown }).result === "string"
  )
    return (value as { result: string }).result;
  if (
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    typeof (value as { prompt?: unknown }).prompt === "string"
  )
    return (value as { prompt: string }).prompt;
  return JSON.stringify(value, null, 2) ?? "";
}
export function workflowRecordExecution(
  record: CrewonWorkflowRecord,
): CrewonWorkflowExecution {
  const run = record.config.runs?.[0];
  if (!run) throw Error("workflow_execution_not_loaded");
  return { ...run, workflowId: record.config.workflowId };
}
