export type CrewonWorkflowAgentNode = {
  nodeId: string;
  type?: "agent";
  title: string;
  agentId: string;
  agentName: string;
  instruction: string;
};

export type CrewonWorkflowHumanGateNode = {
  nodeId: string;
  type: "humanGate";
  title: string;
  instruction: string;
};

export type CrewonWorkflowNode =
  | CrewonWorkflowAgentNode
  | CrewonWorkflowHumanGateNode;

export type CrewonWorkflowConfig = {
  workflowId: string;
  name: string;
  description: string;
  lead: string;
  status: string;
  resourceSource: "crewon";
  createdAt: number;
  updatedAt: number;
  nodes: CrewonWorkflowNode[];
  runs?: CrewonWorkflowRun[];
};

export type CrewonWorkflowRecord = {
  filePath: string;
  savedAt: string;
  config: CrewonWorkflowConfig;
};

export type CrewonWorkflowNodeInput =
  | {
      type: "agent";
      title: string;
      agentId: string;
      agentName: string;
      instruction: string;
    }
  | {
      type: "humanGate";
      title: string;
      instruction: string;
    };

export type CrewonWorkflowNodeExecution = {
  nodeId: string;
  nodeType?: string;
  title: string;
  agentId?: string | null;
  agentName?: string;
  status: string;
  input?: string;
  output: string;
  error: string | null;
  threadId?: string | null;
  turnId?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
};

export type CrewonWorkflowRun = {
  executionId: string;
  status: string;
  input: string;
  output: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  executedNodes: CrewonWorkflowNodeExecution[];
};

export type CrewonWorkflowExecution = {
  executionId: string;
  workflowId: string;
  status: string;
  output: string;
  executedNodes: CrewonWorkflowNodeExecution[];
  error: string | null;
};

export function crewonWorkflowConfigFromValue(
  value: unknown,
): CrewonWorkflowConfig | null {
  if (
    !isObject(value) ||
    !isString(value.workflowId) ||
    !isString(value.name) ||
    !isString(value.description) ||
    !isString(value.lead) ||
    !isString(value.status) ||
    value.resourceSource !== "crewon" ||
    !isNumber(value.createdAt) ||
    !isNumber(value.updatedAt) ||
    !Array.isArray(value.nodes) ||
    !value.nodes.every(isWorkflowNode) ||
    (value.runs !== undefined &&
      (!Array.isArray(value.runs) || !value.runs.every(isWorkflowRun)))
  ) {
    return null;
  }
  return value as CrewonWorkflowConfig;
}

export function workflowRecordsWithRuntimeUpdate(
  records: CrewonWorkflowRecord[],
  update: { filePath: string; config: unknown },
): CrewonWorkflowRecord[] {
  const config = crewonWorkflowConfigFromValue(update.config);
  if (!config) {
    return records;
  }
  let matched = false;
  const next = records.map((record) => {
    if (
      record.filePath !== update.filePath &&
      record.config.workflowId !== config.workflowId
    ) {
      return record;
    }
    matched = true;
    return { ...record, filePath: update.filePath, config };
  });
  return matched ? next : records;
}

function isWorkflowNode(value: unknown): value is CrewonWorkflowNode {
  if (
    !isObject(value) ||
    !isString(value.nodeId) ||
    !isString(value.title) ||
    !isString(value.instruction)
  ) {
    return false;
  }
  return value.type === "humanGate"
    ? true
    : (value.type === undefined || value.type === "agent") &&
        isString(value.agentId) &&
        isString(value.agentName);
}

function isWorkflowRun(value: unknown): value is CrewonWorkflowRun {
  return (
    isObject(value) &&
    isString(value.executionId) &&
    isString(value.status) &&
    isString(value.input) &&
    isString(value.output) &&
    isNullableString(value.error) &&
    isNumber(value.createdAt) &&
    isNumber(value.updatedAt) &&
    Array.isArray(value.executedNodes) &&
    value.executedNodes.every(isWorkflowNodeExecution)
  );
}

function isWorkflowNodeExecution(
  value: unknown,
): value is CrewonWorkflowNodeExecution {
  return (
    isObject(value) &&
    isString(value.nodeId) &&
    isOptionalString(value.nodeType) &&
    isString(value.title) &&
    isOptionalNullableString(value.agentId) &&
    isOptionalString(value.agentName) &&
    isString(value.status) &&
    isOptionalString(value.input) &&
    isString(value.output) &&
    isNullableString(value.error) &&
    isOptionalNullableString(value.threadId) &&
    isOptionalNullableString(value.turnId) &&
    isOptionalNullableNumber(value.startedAt) &&
    isOptionalNullableNumber(value.completedAt)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isOptionalNullableString(
  value: unknown,
): value is string | null | undefined {
  return value === undefined || isNullableString(value);
}

function isOptionalNullableNumber(
  value: unknown,
): value is number | null | undefined {
  return value === undefined || value === null || isNumber(value);
}
