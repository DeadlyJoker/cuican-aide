export const AUTOMATION_SCHEDULE_TYPES = [
  "daily",
  "weekly",
  "interval",
  "once",
] as const;

export const MAX_AUTOMATION_INSTRUCTION_BYTES = 9_999;

export type AutomationScheduleType = (typeof AUTOMATION_SCHEDULE_TYPES)[number];

export type AutomationSchedule = Readonly<{
  scheduleType: AutomationScheduleType;
  nextRunAt: string;
  intervalSeconds: number;
  time: string;
  weekday: number;
  timezone: string;
}>;

export type AutomationDefinition = Readonly<{
  schemaVersion: "crewon.automation.v0";
  automationId: string;
  tenantId: string;
  spaceId: string;
  createdByPrincipalId?: string;
  createdByActorId: string;
  threadId: string;
  title: string;
  prompt: string;
  agentVersionId: string;
  schedule: AutomationSchedule;
  executionMode: "manualOnly" | "scheduled";
  revision: 1;
  createdAt: string;
  updatedAt: string;
}>;

export type CreateAutomationDefinitionInput = Readonly<{
  automationId: string;
  tenantId: string;
  spaceId: string;
  createdByPrincipalId?: string;
  createdByActorId: string;
  threadId: string;
  title: string;
  prompt: string;
  agentVersionId: string;
  schedule: AutomationSchedule;
  executionMode?: "manualOnly" | "scheduled";
  createdAt: string;
}>;

/** Server-derived provenance carried by one manual Automation invocation. */
export type AutomationInvocationBinding = Readonly<{
  automationId: string;
  automationRevision: 1;
  definitionDigest: string;
  instructionDigest: string;
  invocationId: string;
  runId: string;
  routeDigest: string;
}>;

export type AutomationInvocationOrigin = Readonly<{
  kind: "automation";
  binding: AutomationInvocationBinding;
}>;

export class AutomationDefinitionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AutomationDefinitionError";
    this.code = code;
  }
}

export function createAutomationDefinition(
  input: CreateAutomationDefinitionInput,
): AutomationDefinition {
  const value = requireObject(input, "automation_definition_input_invalid");
  requireExactKeys(
    value,
    value.executionMode === undefined && value.createdByPrincipalId === undefined
      ? [
          "agentVersionId",
          "automationId",
          "createdAt",
          "createdByActorId",
          "prompt",
          "schedule",
          "spaceId",
          "tenantId",
          "threadId",
          "title",
        ]
      : [
          "agentVersionId",
          "automationId",
          "createdAt",
          "createdByActorId",
          ...(value.createdByPrincipalId === undefined
            ? []
            : ["createdByPrincipalId"]),
          ...(value.executionMode === undefined ? [] : ["executionMode"]),
          "prompt",
          "schedule",
          "spaceId",
          "tenantId",
          "threadId",
          "title",
        ],
    "automation_definition_input_invalid",
  );
  const createdAt = requireTimestamp(
    value.createdAt,
    "automation_created_at_invalid",
  );
  return parseAutomationDefinition({
    schemaVersion: "crewon.automation.v0",
    automationId: value.automationId,
    tenantId: value.tenantId,
    spaceId: value.spaceId,
    ...(value.createdByPrincipalId === undefined
      ? {}
      : { createdByPrincipalId: value.createdByPrincipalId }),
    createdByActorId: value.createdByActorId,
    threadId: value.threadId,
    title: value.title,
    prompt: value.prompt,
    agentVersionId: value.agentVersionId,
    schedule: value.schedule,
    executionMode: value.executionMode ?? "manualOnly",
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
}

export function parseAutomationDefinition(
  input: unknown,
): AutomationDefinition {
  const value = requireObject(input, "automation_state_invalid");
  requireExactKeys(
    value,
    [
      "agentVersionId",
      "automationId",
      "createdAt",
      "createdByActorId",
      ...(value.createdByPrincipalId === undefined
        ? []
        : ["createdByPrincipalId"]),
      "executionMode",
      "prompt",
      "revision",
      "schedule",
      "schemaVersion",
      "spaceId",
      "tenantId",
      "threadId",
      "title",
      "updatedAt",
    ],
    "automation_state_invalid",
  );
  if (
    value.schemaVersion !== "crewon.automation.v0" ||
    (value.executionMode !== "manualOnly" &&
      value.executionMode !== "scheduled") ||
    value.revision !== 1
  ) {
    throw new AutomationDefinitionError("automation_state_invalid");
  }
  const automationId = requireOpaqueId(
    value.automationId,
    "automation_id_invalid",
  );
  const tenantId = requireOpaqueId(
    value.tenantId,
    "automation_tenant_id_invalid",
  );
  const spaceId = requireOpaqueId(value.spaceId, "automation_space_id_invalid");
  const createdByActorId = requireOpaqueId(
    value.createdByActorId,
    "automation_actor_id_invalid",
  );
  const createdByPrincipalId =
    value.createdByPrincipalId === undefined
      ? undefined
      : requireOpaqueId(
          value.createdByPrincipalId,
          "automation_principal_id_invalid",
        );
  const threadId = requireOpaqueId(
    value.threadId,
    "automation_thread_id_invalid",
  );
  const title = requireBoundedText(
    value.title,
    256,
    "automation_title_invalid",
  );
  const prompt = requireBoundedText(
    value.prompt,
    MAX_AUTOMATION_INSTRUCTION_BYTES,
    "automation_prompt_invalid",
  );
  const agentVersionId = requireOpaqueId(
    value.agentVersionId,
    "automation_agent_version_id_invalid",
  );
  const schedule = parseAutomationSchedule(value.schedule);
  const createdAt = requireTimestamp(
    value.createdAt,
    "automation_created_at_invalid",
  );
  const updatedAt = requireTimestamp(
    value.updatedAt,
    "automation_updated_at_invalid",
  );
  if (createdAt !== updatedAt) {
    throw new AutomationDefinitionError("automation_state_invalid");
  }
  const definition: AutomationDefinition = {
    schemaVersion: value.schemaVersion,
    automationId,
    tenantId,
    spaceId,
    ...(createdByPrincipalId === undefined ? {} : { createdByPrincipalId }),
    createdByActorId,
    threadId,
    title,
    prompt,
    agentVersionId,
    schedule,
    executionMode: value.executionMode,
    revision: value.revision,
    createdAt,
    updatedAt,
  };
  requireInstructionWithinLimit(definition);
  return structuredClone(definition);
}

export function validateAutomationDefinition(
  input: unknown,
): asserts input is AutomationDefinition {
  parseAutomationDefinition(input);
}

export function parseAutomationSchedule(input: unknown): AutomationSchedule {
  const value = requireObject(input, "automation_schedule_invalid");
  requireExactKeys(
    value,
    [
      "intervalSeconds",
      "nextRunAt",
      "scheduleType",
      "time",
      "timezone",
      "weekday",
    ],
    "automation_schedule_invalid",
  );
  if (
    typeof value.scheduleType !== "string" ||
    !AUTOMATION_SCHEDULE_TYPES.includes(
      value.scheduleType as AutomationScheduleType,
    ) ||
    !Number.isSafeInteger(value.intervalSeconds) ||
    Number(value.intervalSeconds) < 0 ||
    Number(value.intervalSeconds) > 366 * 24 * 60 * 60 ||
    !Number.isSafeInteger(value.weekday) ||
    Number(value.weekday) < 0 ||
    Number(value.weekday) > 6 ||
    typeof value.time !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/u.test(value.time) ||
    (value.scheduleType === "interval" &&
      Number(value.intervalSeconds) < 5 * 60)
  ) {
    throw new AutomationDefinitionError("automation_schedule_invalid");
  }
  return {
    scheduleType: value.scheduleType as AutomationScheduleType,
    nextRunAt: requireTimestamp(
      value.nextRunAt,
      "automation_next_run_at_invalid",
    ),
    intervalSeconds: Number(value.intervalSeconds),
    time: value.time,
    weekday: Number(value.weekday),
    timezone: requireBoundedText(
      value.timezone,
      256,
      "automation_schedule_invalid",
    ),
  };
}

export function validateAutomationSchedule(
  input: unknown,
): asserts input is AutomationSchedule {
  parseAutomationSchedule(input);
}

export function parseAutomationInvocationBinding(
  input: unknown,
): AutomationInvocationBinding {
  const value = requireObject(input, "automation_invocation_binding_invalid");
  requireExactKeys(
    value,
    [
      "automationId",
      "automationRevision",
      "definitionDigest",
      "instructionDigest",
      "invocationId",
      "routeDigest",
      "runId",
    ],
    "automation_invocation_binding_invalid",
  );
  if (
    value.automationRevision !== 1 ||
    typeof value.definitionDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.definitionDigest) ||
    typeof value.instructionDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.instructionDigest) ||
    typeof value.routeDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.routeDigest)
  ) {
    throw new AutomationDefinitionError(
      "automation_invocation_binding_invalid",
    );
  }
  return {
    automationId: requireOpaqueId(
      value.automationId,
      "automation_invocation_binding_invalid",
    ),
    automationRevision: value.automationRevision,
    definitionDigest: value.definitionDigest,
    instructionDigest: value.instructionDigest,
    invocationId: requireOpaqueId(
      value.invocationId,
      "automation_invocation_binding_invalid",
    ),
    runId: requireOpaqueId(
      value.runId,
      "automation_invocation_binding_invalid",
    ),
    routeDigest: value.routeDigest,
  };
}

export function validateAutomationInvocationBinding(
  input: unknown,
): asserts input is AutomationInvocationBinding {
  parseAutomationInvocationBinding(input);
}

export function parseAutomationInvocationOrigin(
  input: unknown,
): AutomationInvocationOrigin {
  const value = requireObject(input, "automation_invocation_origin_invalid");
  requireExactKeys(
    value,
    ["binding", "kind"],
    "automation_invocation_origin_invalid",
  );
  if (value.kind !== "automation") {
    throw new AutomationDefinitionError("automation_invocation_origin_invalid");
  }
  try {
    return {
      kind: value.kind,
      binding: parseAutomationInvocationBinding(value.binding),
    };
  } catch (error) {
    throw new AutomationDefinitionError("automation_invocation_origin_invalid");
  }
}

export function validateAutomationInvocationOrigin(
  input: unknown,
): asserts input is AutomationInvocationOrigin {
  parseAutomationInvocationOrigin(input);
}

export function renderAutomationInstruction(
  definition: AutomationDefinition,
): string {
  const parsed = parseAutomationDefinition(definition);
  return renderAutomationInstructionUnchecked(parsed);
}

function requireInstructionWithinLimit(definition: AutomationDefinition): void {
  if (
    utf8ByteLength(renderAutomationInstructionUnchecked(definition)) >
    MAX_AUTOMATION_INSTRUCTION_BYTES
  ) {
    throw new AutomationDefinitionError("automation_instruction_too_large");
  }
}

function renderAutomationInstructionUnchecked(
  definition: AutomationDefinition,
): string {
  return [
    `<automation_run automation_id="${xmlEscape(definition.automationId)}" automation_revision="${definition.revision}">`,
    `<title>${xmlEscape(definition.title)}</title>`,
    `<task>${xmlEscape(definition.prompt)}</task>`,
    "Record the result, next steps, and risks in this Automation result thread.",
    "</automation_run>",
  ].join("\n");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function requireObject(value: unknown, code: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new AutomationDefinitionError(code);
  }
  return value;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new AutomationDefinitionError(code);
  }
}

function requireOpaqueId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new AutomationDefinitionError(code);
  }
  return value;
}

function requireBoundedText(
  value: unknown,
  maximumBytes: number,
  code: string,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    utf8ByteLength(value) > maximumBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new AutomationDefinitionError(code);
  }
  return value;
}

function requireTimestamp(value: unknown, code: string): string {
  if (typeof value !== "string") {
    throw new AutomationDefinitionError(code);
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/u.exec(
      value,
    );
  const milliseconds = Date.parse(value);
  if (match === null || !Number.isFinite(milliseconds)) {
    throw new AutomationDefinitionError(code);
  }
  const parsed = new Date(milliseconds);
  if (
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() + 1 !== Number(match[2]) ||
    parsed.getUTCDate() !== Number(match[3]) ||
    parsed.getUTCHours() !== Number(match[4]) ||
    parsed.getUTCMinutes() !== Number(match[5]) ||
    parsed.getUTCSeconds() !== Number(match[6])
  ) {
    throw new AutomationDefinitionError(code);
  }
  return value;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
