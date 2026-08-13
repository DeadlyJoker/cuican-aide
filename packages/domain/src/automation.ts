export const MAX_AUTOMATION_INSTRUCTION_BYTES = 9_999;
export const AUTOMATION_MISFIRE_POLICY = "coalesceLatest" as const;
export const AUTOMATION_TIME_DISAMBIGUATION = "compatible" as const;

export type AutomationScheduleSpec =
  | Readonly<{ kind: "once"; at: string }>
  | Readonly<{ kind: "interval"; anchorAt: string; everySeconds: number }>
  | Readonly<{ kind: "daily"; localTime: string; timezone: string }>
  | Readonly<{
      kind: "weekly";
      isoWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
      localTime: string;
      timezone: string;
    }>;

export type AutomationOwnerBinding = Readonly<{
  principalId: string;
  actorId: string;
  tenantId: string;
  spaceId: string;
}>;

export type AutomationScheduleState = Readonly<{
  schemaVersion: "crewon.automation-schedule-state.v1";
  automationId: string;
  scheduleRevision: 1;
  status: "enabled" | "disabled" | "completed";
  nextOccurrenceAt: string | null;
  lastScheduledFor: string | null;
  retryAt: string | null;
  revision: number;
  updatedAt: string;
}>;

export type AutomationDefinition = Readonly<{
  schemaVersion: "crewon.automation.v1";
  automationId: string;
  tenantId: string;
  spaceId: string;
  owner: AutomationOwnerBinding;
  threadId: string;
  title: string;
  prompt: string;
  agentVersionId: string;
  schedule: AutomationScheduleSpec;
  misfirePolicy: typeof AUTOMATION_MISFIRE_POLICY;
  revision: 1;
  createdAt: string;
  updatedAt: string;
}>;

export type CreateAutomationDefinitionInput = Readonly<{
  automationId: string;
  tenantId: string;
  spaceId: string;
  owner: AutomationOwnerBinding;
  threadId: string;
  title: string;
  prompt: string;
  agentVersionId: string;
  schedule: AutomationScheduleSpec;
  createdAt: string;
}>;

export type AutomationInvocationTrigger =
  | Readonly<{ kind: "manual" }>
  | Readonly<{
      kind: "schedule";
      scheduleRevision: 1;
      scheduledFor: string;
      occurrenceDigest: string;
    }>;

/** Server-derived provenance carried by one Automation invocation. */
export type AutomationInvocationBinding = Readonly<{
  automationId: string;
  automationRevision: 1;
  definitionDigest: string;
  instructionDigest: string;
  invocationId: string;
  runId: string;
  routeDigest: string;
  trigger: AutomationInvocationTrigger;
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
    [
      "agentVersionId",
      "automationId",
      "createdAt",
      "owner",
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
    schemaVersion: "crewon.automation.v1",
    automationId: value.automationId,
    tenantId: value.tenantId,
    spaceId: value.spaceId,
    owner: value.owner,
    threadId: value.threadId,
    title: value.title,
    prompt: value.prompt,
    agentVersionId: value.agentVersionId,
    schedule: value.schedule,
    misfirePolicy: AUTOMATION_MISFIRE_POLICY,
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
      "owner",
      "misfirePolicy",
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
    value.schemaVersion !== "crewon.automation.v1" ||
    value.misfirePolicy !== AUTOMATION_MISFIRE_POLICY ||
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
  const owner = parseAutomationOwnerBinding(value.owner);
  if (owner.tenantId !== tenantId || owner.spaceId !== spaceId) {
    throw new AutomationDefinitionError("automation_owner_scope_invalid");
  }
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
  const schedule = parseAutomationScheduleSpec(value.schedule);
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
    owner,
    threadId,
    title,
    prompt,
    agentVersionId,
    schedule,
    misfirePolicy: value.misfirePolicy,
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

export function parseAutomationScheduleSpec(
  input: unknown,
): AutomationScheduleSpec {
  const value = requireObject(input, "automation_schedule_invalid");
  if (value.kind === "once") {
    requireExactKeys(value, ["at", "kind"], "automation_schedule_invalid");
    return {
      kind: value.kind,
      at: requireTimestamp(value.at, "automation_schedule_invalid"),
    };
  }
  if (value.kind === "interval") {
    requireExactKeys(
      value,
      ["anchorAt", "everySeconds", "kind"],
      "automation_schedule_invalid",
    );
    if (
      !Number.isSafeInteger(value.everySeconds) ||
      Number(value.everySeconds) < 5 * 60 ||
      Number(value.everySeconds) > 366 * 24 * 60 * 60
    ) {
      throw new AutomationDefinitionError("automation_schedule_invalid");
    }
    return {
      kind: value.kind,
      anchorAt: requireTimestamp(value.anchorAt, "automation_schedule_invalid"),
      everySeconds: Number(value.everySeconds),
    };
  }
  if (value.kind === "daily" || value.kind === "weekly") {
    requireExactKeys(
      value,
      value.kind === "daily"
        ? ["kind", "localTime", "timezone"]
        : ["isoWeekday", "kind", "localTime", "timezone"],
      "automation_schedule_invalid",
    );
    const localTime = requireLocalTime(value.localTime);
    const timezone = requireIanaTimezone(value.timezone);
    if (value.kind === "daily")
      return { kind: value.kind, localTime, timezone };
    if (
      !Number.isSafeInteger(value.isoWeekday) ||
      Number(value.isoWeekday) < 1 ||
      Number(value.isoWeekday) > 7
    ) {
      throw new AutomationDefinitionError("automation_schedule_invalid");
    }
    return {
      kind: value.kind,
      isoWeekday: Number(value.isoWeekday) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
      localTime,
      timezone,
    };
  }
  throw new AutomationDefinitionError("automation_schedule_invalid");
}

export function validateAutomationScheduleSpec(
  input: unknown,
): asserts input is AutomationScheduleSpec {
  parseAutomationScheduleSpec(input);
}

export function parseAutomationOwnerBinding(
  input: unknown,
): AutomationOwnerBinding {
  const value = requireObject(input, "automation_owner_invalid");
  requireExactKeys(
    value,
    ["actorId", "principalId", "spaceId", "tenantId"],
    "automation_owner_invalid",
  );
  return {
    principalId: requireOpaqueId(value.principalId, "automation_owner_invalid"),
    actorId: requireOpaqueId(value.actorId, "automation_owner_invalid"),
    tenantId: requireOpaqueId(value.tenantId, "automation_owner_invalid"),
    spaceId: requireOpaqueId(value.spaceId, "automation_owner_invalid"),
  };
}

export function parseAutomationScheduleState(
  input: unknown,
): AutomationScheduleState {
  const value = requireObject(input, "automation_schedule_state_invalid");
  requireExactKeys(
    value,
    [
      "automationId",
      "lastScheduledFor",
      "nextOccurrenceAt",
      "retryAt",
      "revision",
      "scheduleRevision",
      "schemaVersion",
      "status",
      "updatedAt",
    ],
    "automation_schedule_state_invalid",
  );
  if (
    value.schemaVersion !== "crewon.automation-schedule-state.v1" ||
    value.scheduleRevision !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !["enabled", "disabled", "completed"].includes(String(value.status))
  ) {
    throw new AutomationDefinitionError("automation_schedule_state_invalid");
  }
  const nextOccurrenceAt = optionalTimestamp(value.nextOccurrenceAt);
  if (
    (value.status === "enabled" && nextOccurrenceAt === null) ||
    (value.status === "completed" && nextOccurrenceAt !== null)
  ) {
    throw new AutomationDefinitionError("automation_schedule_state_invalid");
  }
  return {
    schemaVersion: value.schemaVersion,
    automationId: requireOpaqueId(
      value.automationId,
      "automation_schedule_state_invalid",
    ),
    scheduleRevision: value.scheduleRevision,
    status: value.status as AutomationScheduleState["status"],
    nextOccurrenceAt,
    lastScheduledFor: optionalTimestamp(value.lastScheduledFor),
    retryAt: optionalTimestamp(value.retryAt),
    revision: Number(value.revision),
    updatedAt: requireTimestamp(
      value.updatedAt,
      "automation_schedule_state_invalid",
    ),
  };
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
      "trigger",
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
    trigger: parseAutomationInvocationTrigger(value.trigger),
  };
}

export function parseAutomationInvocationTrigger(
  input: unknown,
): AutomationInvocationTrigger {
  const value = requireObject(input, "automation_invocation_trigger_invalid");
  if (value.kind === "manual") {
    requireExactKeys(value, ["kind"], "automation_invocation_trigger_invalid");
    return { kind: value.kind };
  }
  if (value.kind !== "schedule") {
    throw new AutomationDefinitionError(
      "automation_invocation_trigger_invalid",
    );
  }
  requireExactKeys(
    value,
    ["kind", "occurrenceDigest", "scheduledFor", "scheduleRevision"],
    "automation_invocation_trigger_invalid",
  );
  if (
    value.scheduleRevision !== 1 ||
    typeof value.occurrenceDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.occurrenceDigest)
  ) {
    throw new AutomationDefinitionError(
      "automation_invocation_trigger_invalid",
    );
  }
  return {
    kind: value.kind,
    scheduleRevision: value.scheduleRevision,
    scheduledFor: requireTimestamp(
      value.scheduledFor,
      "automation_invocation_trigger_invalid",
    ),
    occurrenceDigest: value.occurrenceDigest,
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

function optionalTimestamp(value: unknown): string | null {
  return value === null
    ? null
    : requireTimestamp(value, "automation_schedule_state_invalid");
}

function requireLocalTime(value: unknown): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    throw new AutomationDefinitionError("automation_schedule_invalid");
  }
  return value;
}

function requireIanaTimezone(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new AutomationDefinitionError("automation_schedule_invalid");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    throw new AutomationDefinitionError("automation_schedule_invalid");
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
