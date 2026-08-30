import type {
  AutomationMutationResponse,
  AutomationView,
  CreateAutomationRequest,
  GetAutomationResponse,
  GetThreadResponse,
  ListAutomationsResponse,
  RunAutomationNowResponse,
  RunView,
  AutomationSchedule,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
  parseRunView,
  RunViewValidationError,
  type ControlApiRequestOptions,
} from "@crewon/control-client";

const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 100;

export type AutomationCreateIntent = Readonly<{
  threadId: string;
  title: string;
  prompt: string;
  agentVersionId: string | null;
  schedule: AutomationSchedule | null;
}>;

export type AutomationRunAdopter = Readonly<{
  adoptAutomationRun(automation: AutomationView, run: RunView): Promise<void>;
}>;

export class ControlAutomationRuntime {
  readonly #client: ControlApiClient;
  readonly #adopter: AutomationRunAdopter;
  readonly #idempotencyKey: (operation: string) => string;

  constructor(config: {
    client: ControlApiClient;
    adopter: AutomationRunAdopter;
    idempotencyKey?: (operation: string) => string;
  }) {
    this.#client = config.client;
    this.#adopter = config.adopter;
    this.#idempotencyKey =
      config.idempotencyKey ??
      ((operation) => `${operation}:${globalThis.crypto.randomUUID()}`);
  }

  async listAutomations(
    options: ControlApiRequestOptions = {},
  ): Promise<readonly AutomationView[]> {
    const definitions: AutomationView[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await this.#client.listAutomations(
        {
          ...(cursor === null ? {} : { cursor }),
          limit: PAGE_SIZE,
        },
        options,
      );
      validateListResponse(response);
      definitions.push(...response.data.map(validateAutomationView));
      const nextCursor = response.nextCursor;
      if (nextCursor === null) {
        return definitions;
      }
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw new ControlApiProtocolError(
          "control_automation_list_cursor_repeated",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error("control_automation_list_page_limit_exceeded");
  }

  async getAutomation(
    automationId: string,
    options: ControlApiRequestOptions = {},
  ): Promise<AutomationView> {
    const response = await this.#client.getAutomation(automationId, options);
    requireExactKeys(
      response,
      ["automation"],
      "control_automation_get_response_invalid",
    );
    const automation = validateAutomationView(response.automation);
    if (automation.automationId !== automationId) {
      throw new ControlApiProtocolError(
        "control_automation_get_response_invalid",
      );
    }
    return automation;
  }

  async createAutomation(
    intent: AutomationCreateIntent,
    options: ControlApiRequestOptions = {},
  ): Promise<AutomationView> {
    requireIntentExactKeys(
      intent,
      ["agentVersionId", "prompt", "schedule", "threadId", "title"],
      "control_automation_create_intent_invalid",
    );
    const current = await this.#client.getThread(intent.threadId, options);
    validateActiveThread(current, intent.threadId);
    const command: CreateAutomationRequest = {
      threadId: intent.threadId,
      expectedThreadRevision: current.thread.revision,
      title: intent.title,
      prompt: intent.prompt,
      agentVersionId: intent.agentVersionId,
      schedule: intent.schedule,
    };
    return this.#commit(
      "automation.create",
      () => this.#rehydrateThread(intent.threadId, options),
      async (idempotencyKey) =>
        validateCreateResponse(
          await this.#client.createAutomation(command, idempotencyKey, options),
          command,
        ),
    );
  }

  async runAutomationNow(
    automationId: string,
    options: ControlApiRequestOptions = {},
  ): Promise<RunAutomationNowResponse> {
    const automation = await this.getAutomation(automationId, options);
    const current = await this.#client.getThread(automation.threadId, options);
    validateActiveThread(current, automation.threadId);
    const response = await this.#commit(
      "automation.runNow",
      () =>
        this.#rehydrateAutomation(automationId, automation.threadId, options),
      async (idempotencyKey) =>
        validateRunResponse(
          await this.#client.runAutomationNow(
            automationId,
            {
              expectedAutomationRevision: automation.revision,
              expectedThreadRevision: current.thread.revision,
            },
            idempotencyKey,
            options,
          ),
          automation,
        ),
    );
    await this.#adopter.adoptAutomationRun(response.automation, response.run);
    return structuredClone(response);
  }

  async #commit<Result>(
    operation: string,
    rehydrateConflict: () => Promise<void>,
    commit: (idempotencyKey: string) => Promise<Result>,
  ): Promise<Result> {
    const idempotencyKey = this.#idempotencyKey(operation);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await commit(idempotencyKey);
      } catch (error) {
        if (error instanceof ControlApiClientError && error.status === 409) {
          await rehydrateConflict();
          throw error;
        }
        const unknownOutcome =
          error instanceof TypeError ||
          error instanceof ControlApiProtocolError ||
          (error instanceof ControlApiClientError &&
            error.category === "unknownOutcome");
        if (!unknownOutcome || attempt === 1) {
          throw error;
        }
      }
    }
    throw new Error("control_automation_mutation_retry_invariant");
  }

  async #rehydrateThread(
    threadId: string,
    options: ControlApiRequestOptions,
  ): Promise<void> {
    await this.#client.getThread(threadId, options);
  }

  async #rehydrateAutomation(
    automationId: string,
    threadId: string,
    options: ControlApiRequestOptions,
  ): Promise<void> {
    await Promise.all([
      this.#client.getAutomation(automationId, options),
      this.#client.getThread(threadId, options),
    ]);
  }
}

function validateListResponse(response: ListAutomationsResponse): void {
  requireExactKeys(
    response,
    ["data", "nextCursor"],
    "control_automation_list_response_invalid",
  );
  if (
    !Array.isArray(response.data) ||
    (response.nextCursor !== null &&
      (!isBoundedText(response.nextCursor, 512) ||
        !/^[A-Za-z0-9_-]+$/u.test(response.nextCursor)))
  ) {
    throw new ControlApiProtocolError(
      "control_automation_list_response_invalid",
    );
  }
}

function validateCreateResponse(
  response: AutomationMutationResponse,
  command: CreateAutomationRequest,
): AutomationView {
  requireExactKeys(
    response,
    ["automation", "disposition"],
    "control_automation_create_response_invalid",
  );
  if (
    response.disposition !== "committed" &&
    response.disposition !== "replayed"
  ) {
    throw new ControlApiProtocolError(
      "control_automation_create_response_invalid",
    );
  }
  const automation = validateAutomationView(response.automation);
  if (
    automation.threadId !== command.threadId ||
    automation.title !== command.title ||
    automation.prompt !== command.prompt ||
    (command.agentVersionId !== null &&
      automation.agentVersionId !== command.agentVersionId) ||
    automation.automaticScheduling !== (command.schedule !== null) ||
    JSON.stringify(automation.schedule) !==
      JSON.stringify(
        command.schedule ?? {
          scheduleType: "once",
          nextRunAt: "9999-12-31T23:59:59Z",
          intervalSeconds: 0,
          time: "00:00",
          weekday: 0,
          timezone: "UTC",
        },
      )
  ) {
    throw new ControlApiProtocolError(
      "control_automation_create_response_invalid",
    );
  }
  return automation;
}

function validateRunResponse(
  response: RunAutomationNowResponse,
  expected: AutomationView,
): RunAutomationNowResponse {
  requireExactKeys(
    response,
    ["automation", "disposition", "invocation", "run"],
    "control_automation_run_response_invalid",
  );
  if (
    response.disposition !== "committed" &&
    response.disposition !== "replayed"
  ) {
    throw new ControlApiProtocolError(
      "control_automation_run_response_invalid",
    );
  }
  const automation = validateAutomationView(response.automation);
  requireExactKeys(
    response.invocation,
    ["automationId", "runId"],
    "control_automation_run_response_invalid",
  );
  let run: RunView;
  try {
    run = parseRunView(response.run, automation.threadId);
  } catch (error) {
    if (error instanceof RunViewValidationError) {
      throw new ControlApiProtocolError(
        "control_automation_run_response_invalid",
      );
    }
    throw error;
  }
  if (
    !sameAutomation(automation, expected) ||
    response.invocation.automationId !== automation.automationId ||
    response.invocation.runId !== run.runId ||
    run.purpose !== "turn" ||
    run.goalBinding !== null
  ) {
    throw new ControlApiProtocolError(
      "control_automation_run_response_invalid",
    );
  }
  return structuredClone({ ...response, automation, run });
}

function sameAutomation(left: AutomationView, right: AutomationView): boolean {
  return (
    left.automationId === right.automationId &&
    left.threadId === right.threadId &&
    left.title === right.title &&
    left.prompt === right.prompt &&
    left.agentVersionId === right.agentVersionId &&
    left.executionMode === right.executionMode &&
    left.automaticScheduling === right.automaticScheduling &&
    JSON.stringify(left.schedule) === JSON.stringify(right.schedule) &&
    left.revision === right.revision &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function validateAutomationView(input: AutomationView): AutomationView {
  requireExactKeys(
    input,
    [
      "agentVersionId",
      "automaticScheduling",
      "automationId",
      "createdAt",
      "executionMode",
      "prompt",
      "revision",
      "schedule",
      "threadId",
      "title",
      "updatedAt",
    ],
    "control_automation_view_invalid",
  );
  if (
    (input.executionMode !== "manualOnly" &&
      input.executionMode !== "scheduled") ||
    input.automaticScheduling !== (input.executionMode === "scheduled") ||
    input.revision !== 1 ||
    !isBoundedText(input.automationId, 128) ||
    !isBoundedText(input.threadId, 128) ||
    !isBoundedText(input.title, 256) ||
    !isBoundedText(input.prompt, 9_999) ||
    new TextEncoder().encode(input.prompt).byteLength > 9_999 ||
    !isBoundedText(input.agentVersionId, 512) ||
    !isTimestamp(input.createdAt) ||
    !isTimestamp(input.updatedAt) ||
    input.updatedAt !== input.createdAt ||
    !isAutomationSchedule(input.schedule)
  ) {
    throw new ControlApiProtocolError("control_automation_view_invalid");
  }
  return structuredClone(input);
}

function isAutomationSchedule(input: AutomationSchedule): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    Object.keys(input).sort().join(",") ===
      "intervalSeconds,nextRunAt,scheduleType,time,timezone,weekday" &&
    (input.scheduleType === "daily" ||
      input.scheduleType === "weekly" ||
      input.scheduleType === "interval" ||
      input.scheduleType === "once") &&
    Number.isSafeInteger(input.intervalSeconds) &&
    input.intervalSeconds >= 0 &&
    Number.isSafeInteger(input.weekday) &&
    input.weekday >= 0 &&
    input.weekday <= 6 &&
    /^([01]\d|2[0-3]):[0-5]\d$/u.test(input.time) &&
    isBoundedText(input.timezone, 256) &&
    isTimestamp(input.nextRunAt)
  );
}

function validateActiveThread(
  response: GetThreadResponse,
  threadId: string,
): void {
  requireExactKeys(
    response,
    ["eventSequence", "thread"],
    "control_automation_thread_response_invalid",
  );
  requireExactKeys(
    response.thread,
    [
      "archivedAt",
      "createdAt",
      "deletedAt",
      "forkedFromThreadId",
      "forkedThroughHistorySequence",
      "lastMessageSequence",
      "revision",
      "status",
      "threadId",
      "title",
      "updatedAt",
    ],
    "control_automation_thread_response_invalid",
  );
  if (
    response.thread.threadId !== threadId ||
    response.thread.status !== "active" ||
    !Number.isSafeInteger(response.eventSequence) ||
    response.eventSequence < 0 ||
    response.eventSequence !== response.thread.revision ||
    !Number.isSafeInteger(response.thread.revision) ||
    response.thread.revision < 1 ||
    !Number.isSafeInteger(response.thread.lastMessageSequence) ||
    response.thread.lastMessageSequence < 0 ||
    !isTimestamp(response.thread.createdAt) ||
    !isTimestamp(response.thread.updatedAt) ||
    response.thread.archivedAt !== null ||
    response.thread.deletedAt !== null
  ) {
    throw new ControlApiProtocolError(
      "control_automation_thread_response_invalid",
    );
  }
}

function requireExactKeys(
  input: object,
  expected: readonly string[],
  code: string,
): void {
  if (
    input === null ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw new ControlApiProtocolError(code);
  }
  const actual = Object.keys(input).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new ControlApiProtocolError(code);
  }
}

function requireIntentExactKeys(
  input: object,
  expected: readonly string[],
  code: string,
): void {
  try {
    requireExactKeys(input, expected, code);
  } catch {
    throw new Error(code);
  }
}

function isBoundedText(input: unknown, maximum: number): input is string {
  return (
    typeof input === "string" &&
    input.trim().length > 0 &&
    input.length <= maximum
  );
}

function isTimestamp(input: unknown): input is string {
  return (
    typeof input === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(input) &&
    Number.isFinite(Date.parse(input))
  );
}
