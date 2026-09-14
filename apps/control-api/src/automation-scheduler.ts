import { createHash } from "node:crypto";
import {
  StorageAdmissionError,
  type StorageAdmissionPort,
} from "@crewon/application";

import type {
  ActorContext,
  AutomationDefinitionRecord,
  AutomationListCursor,
  AutomationApplicationService,
  AutomationStore,
  ThreadApplicationService,
} from "@crewon/application";
import type { AutomationSchedule } from "@crewon/domain";

const DEFAULT_SCAN_INTERVAL_MS = 1_000;
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES_PER_WAKE = 1;
const DEFAULT_CACHE_LIMIT = 4_096;

type ScheduledAutomations = Pick<
  AutomationApplicationService,
  "runAutomationNow"
>;
type ScheduledThreads = Pick<ThreadApplicationService, "getThread">;

export class AutomationScheduler {
  readonly #automations: ScheduledAutomations;
  readonly #store: Pick<AutomationStore, "listScheduledAutomations">;
  readonly #threads: ScheduledThreads;
  readonly #now: () => string;
  readonly #scanIntervalMs: number | null;
  readonly #storageAdmission: StorageAdmissionPort | undefined;
  readonly #completedOccurrences = new Map<string, string>();
  readonly #completedAutomationCacheLimit: number;
  readonly #maxPagesPerWake: number;
  #cursor: AutomationListCursor | null = null;
  #timer: NodeJS.Timeout | null = null;
  #scan: Promise<void> | null = null;
  #closed = false;
  #lastFailureCode: string | null = null;

  constructor(
    dependencies: {
      automations: ScheduledAutomations;
      store: Pick<AutomationStore, "listScheduledAutomations">;
      threads: ScheduledThreads;
      now: () => string;
      storageAdmission?: StorageAdmissionPort;
    },
    config: {
      scanIntervalMs?: number | null;
      completedAutomationCacheLimit?: number;
      maxPagesPerWake?: number;
    } = {},
  ) {
    this.#automations = dependencies.automations;
    this.#store = dependencies.store;
    this.#threads = dependencies.threads;
    this.#now = dependencies.now;
    this.#storageAdmission = dependencies.storageAdmission;
    this.#completedAutomationCacheLimit = boundedInteger(
      config.completedAutomationCacheLimit ?? DEFAULT_CACHE_LIMIT,
      0,
      16_384,
      "automation_cache_limit_invalid",
    );
    this.#maxPagesPerWake = boundedInteger(
      config.maxPagesPerWake ?? DEFAULT_MAX_PAGES_PER_WAKE,
      1,
      100,
      "automation_scan_page_budget_invalid",
    );
    this.#scanIntervalMs = optionalPositiveInteger(
      config.scanIntervalMs === undefined
        ? DEFAULT_SCAN_INTERVAL_MS
        : config.scanIntervalMs,
      "automation_scan_interval_invalid",
    );
  }

  start(): void {
    if (this.#closed || this.#timer !== null) return;
    void this.wake();
    if (this.#scanIntervalMs === null) return;
    this.#timer = setInterval(() => void this.wake(), this.#scanIntervalMs);
    this.#timer.unref();
  }

  wake(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#scan !== null) return this.#scan;
    const scan = this.#scanSafely().finally(() => {
      if (this.#scan === scan) this.#scan = null;
    });
    this.#scan = scan;
    return scan;
  }

  lastFailureCode(): string | null {
    return this.#lastFailureCode;
  }

  resourceSnapshot(): Readonly<{
    cachedAutomationCount: number;
    cachedIdentityBytes: number;
    cacheLimit: number;
    scanInFlight: boolean;
    hasScanContinuation: boolean;
  }> {
    return {
      cachedAutomationCount: this.#completedOccurrences.size,
      // Two SHA-256 hex strings per entry; excludes Map and JS object overhead.
      cachedIdentityBytes: this.#completedOccurrences.size * 128,
      cacheLimit: this.#completedAutomationCacheLimit,
      scanInFlight: this.#scan !== null,
      hasScanContinuation: this.#cursor !== null,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    try {
      await this.#scan;
    } finally {
      this.#completedOccurrences.clear();
      this.#cursor = null;
    }
  }

  async #scanSafely(): Promise<void> {
    try {
      await this.#scanDueAutomations();
      this.#lastFailureCode = null;
    } catch (error) {
      this.#lastFailureCode = failureCode(error);
    }
  }

  async #scanDueAutomations(): Promise<void> {
    await this.#storageAdmission?.assertNewWorkAllowed();
    if (this.#closed) return;
    const now = this.#now();
    let firstFailure: unknown = null;
    for (let page = 0; page < this.#maxPagesPerWake; page += 1) {
      if (this.#closed) return;
      const records = await this.#store.listScheduledAutomations({
        before: this.#cursor,
        limit: PAGE_SIZE,
      });
      for (const record of records) {
        if (this.#closed) return;
        const definition = record.definition;
        const cursor: AutomationListCursor = {
          updatedAt: definition.updatedAt,
          automationId: definition.automationId,
        };
        const actor: ActorContext = {
          principalId:
            definition.createdByPrincipalId ?? definition.createdByActorId,
          actorId: definition.createdByActorId,
          tenantId: definition.tenantId,
          spaceId: definition.spaceId,
        };
        const scheduledFor = latestScheduledOccurrence(
          definition.schedule,
          now,
        );
        if (scheduledFor === null) {
          this.#cursor = cursor;
          continue;
        }
        const identity = completedOccurrenceIdentity(record, scheduledFor);
        if (
          this.#completedOccurrences.get(identity.automation) ===
          identity.occurrence
        ) {
          this.#rememberCompleted(identity);
          this.#cursor = cursor;
          continue;
        }
        try {
          const thread = await this.#threads.getThread(
            actor,
            definition.threadId,
          );
          if (this.#closed) return;
          await this.#storageAdmission?.assertNewWorkAllowed();
          if (this.#closed) return;
          await this.#automations.runAutomationNow(actor, {
            kind: "automation.runNow",
            ...(definition.skillBinding === undefined ? {} : { scheduledFor }),
            idempotencyKey: scheduledIdempotencyKey(
              definition.automationId,
              scheduledFor,
            ),
            automationId: definition.automationId,
            expectedAutomationRevision: definition.revision,
            expectedThreadRevision: thread.revision,
          });
          this.#rememberCompleted(identity);
        } catch (error) {
          if (error instanceof StorageAdmissionError) throw error;
          firstFailure ??= error;
        }
        this.#cursor = cursor;
      }
      if (records.length < PAGE_SIZE) {
        this.#cursor = null;
        if (firstFailure !== null) throw firstFailure;
        return;
      }
    }
    if (firstFailure !== null) throw firstFailure;
  }

  #rememberCompleted(identity: {
    automation: string;
    occurrence: string;
  }): void {
    if (this.#closed || this.#completedAutomationCacheLimit === 0) return;
    this.#completedOccurrences.delete(identity.automation);
    this.#completedOccurrences.set(identity.automation, identity.occurrence);
    if (this.#completedOccurrences.size > this.#completedAutomationCacheLimit) {
      const oldest = this.#completedOccurrences.keys().next().value;
      if (oldest !== undefined) this.#completedOccurrences.delete(oldest);
    }
  }
}

function completedOccurrenceIdentity(
  record: AutomationDefinitionRecord,
  scheduledFor: string,
): { automation: string; occurrence: string } {
  const definition = record.definition;
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    automation: digest([
      definition.tenantId,
      definition.spaceId,
      definition.automationId,
    ]),
    occurrence: digest([
      scheduledFor,
      record.definitionDigest,
      definition.createdByActorId,
      definition.createdByPrincipalId ?? null,
    ]),
  };
}

export function latestScheduledOccurrence(
  schedule: AutomationSchedule,
  nowIso: string,
): string | null {
  const anchor = Date.parse(schedule.nextRunAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(anchor) || !Number.isFinite(now) || now < anchor) {
    return null;
  }
  if (schedule.scheduleType === "once") {
    return new Date(anchor).toISOString();
  }
  if (schedule.scheduleType === "interval") {
    const intervalMs = schedule.intervalSeconds * 1_000;
    const occurrence =
      anchor + Math.floor((now - anchor) / intervalMs) * intervalMs;
    return new Date(occurrence).toISOString();
  }
  const localNow = zonedParts(new Date(now), schedule.timezone);
  const [hour, minute] = schedule.time.split(":").map(Number);
  const daysBack =
    schedule.scheduleType === "weekly"
      ? (localNow.weekday - schedule.weekday + 7) % 7
      : 0;
  let localDate = shiftLocalDate(localNow, -daysBack);
  let occurrence = wallTimeToInstant(
    { ...localDate, hour: hour ?? 0, minute: minute ?? 0 },
    schedule.timezone,
  );
  if (occurrence > now) {
    localDate = shiftLocalDate(
      localDate,
      schedule.scheduleType === "weekly" ? -7 : -1,
    );
    occurrence = wallTimeToInstant(
      { ...localDate, hour: hour ?? 0, minute: minute ?? 0 },
      schedule.timezone,
    );
  }
  return occurrence < anchor ? null : new Date(occurrence).toISOString();
}

function scheduledIdempotencyKey(
  automationId: string,
  scheduledFor: string,
): string {
  return `scheduled:${createHash("sha256")
    .update(`${automationId}\u0000${scheduledFor}`)
    .digest("hex")}`;
}

type LocalParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}>;

function zonedParts(date: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: weekdays.indexOf(parts.weekday ?? ""),
  };
}

function shiftLocalDate(
  value: Pick<LocalParts, "year" | "month" | "day">,
  days: number,
): Pick<LocalParts, "year" | "month" | "day"> {
  const shifted = new Date(
    Date.UTC(value.year, value.month - 1, value.day + days),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function wallTimeToInstant(
  value: Pick<LocalParts, "year" | "month" | "day" | "hour" | "minute">,
  timeZone: string,
): number {
  const target = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
  );
  let candidate = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = zonedParts(new Date(candidate), timeZone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const delta = target - represented;
    if (delta === 0) return candidate;
    candidate += delta;
  }
  return candidate;
}

function failureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z0-9_]{1,128}$/u.test(error.message)) {
    return error.message;
  }
  return "automation_schedule_failed";
}

function optionalPositiveInteger(
  value: number | null,
  code: string,
): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(code);
  return value;
}
